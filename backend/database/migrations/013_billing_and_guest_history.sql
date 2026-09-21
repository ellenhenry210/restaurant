-- 013_billing_and_guest_history.sql
--
-- Locks in the schema for the payment/billing redesign (SNAPORDER_
-- DATABASE_SCHEMA.md's "Payment & Billing Model" section, revised
-- 2026-09-21 after reconciling against a second, independently-drafted
-- proposal) plus a minimal guest-history capture layer, per two explicit
-- user requests the same day: "payment should default to one bill per
-- table, split only on request" and "guest history shouldn't wait for
-- Phase 2 — start capturing it now, before Phase 1 data is unrecoverable."
--
-- SCHEMA ONLY in this migration — no route/controller code reads or
-- writes these tables yet (that's the next, separate piece of work).
-- Every new FK column added to an EXISTING table (guest_sessions.
-- sitting_id, orders.sitting_id/bill_id, payment_transactions.bill_id)
-- is deliberately NULLABLE for exactly that reason: the routes that
-- would populate them (scan, order creation, payment) aren't updated
-- yet, and making them NOT NULL now would break every currently-passing
-- test and the real running flows. payment_transactions.order_id is
-- kept, not dropped/renamed — bill_id is added alongside it as the
-- transition path, so nothing breaks until the payment routes actually
-- migrate over to it in a later, coordinated change.

-- ============================================================
-- table_sittings — one row per "visit" to a table, from first scan
-- since the table last turned over to full settlement. The missing
-- grouping concept that makes a consolidated table-level bill possible
-- at all: today two guests scanning the same table's QR separately
-- produce two orders with nothing in common.
-- ============================================================
CREATE TABLE table_sittings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,

  status VARCHAR(20) NOT NULL DEFAULT 'open',
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP,

  CONSTRAINT chk_sitting_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT chk_sitting_times CHECK (closed_at IS NULL OR closed_at > opened_at)
);

CREATE INDEX idx_sittings_table ON table_sittings(table_id);
CREATE INDEX idx_sittings_restaurant ON table_sittings(restaurant_id);

-- One open sitting per table at a time — same partial-unique-index
-- pattern as table_assignments' unique_active_assignment_per_table.
CREATE UNIQUE INDEX unique_open_sitting_per_table ON table_sittings(table_id) WHERE status = 'open';

-- ============================================================
-- bills — the payable unit. Exactly ONE bill per sitting, always
-- (never one row per guest — see bill_splits below for how a split
-- is actually represented, revised from an earlier draft that wrongly
-- modeled a split as multiple bill rows).
-- ============================================================
CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sitting_id UUID NOT NULL REFERENCES table_sittings(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  timing VARCHAR(20) NOT NULL,   -- 'pay_now' | 'pay_after' | 'pay_traditional'
  status VARCHAR(20) NOT NULL DEFAULT 'open',

  -- Naira, DECIMAL(10,2) — matching orders/payment_transactions exactly,
  -- not kobo-integer, so amounts are never mixed units across tables.
  subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0,
  tax DECIMAL(10, 2) NOT NULL DEFAULT 0,
  service_charge DECIMAL(10, 2) NOT NULL DEFAULT 0,
  tip_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TIMESTAMP,

  CONSTRAINT chk_bill_timing CHECK (timing IN ('pay_now', 'pay_after', 'pay_traditional')),
  CONSTRAINT chk_bill_status CHECK (status IN ('open', 'split_requested', 'awaiting_payment', 'paid', 'settled_traditionally', 'cancelled')),
  -- One bill per sitting — a sitting is never billed twice.
  CONSTRAINT unique_bill_per_sitting UNIQUE (sitting_id)
);

CREATE INDEX idx_bills_restaurant ON bills(restaurant_id);

-- ============================================================
-- bill_splits / bill_split_shares — created ONLY when a guest
-- explicitly requests a split (bills.status -> 'split_requested').
-- Splits the ONE bill above into shares; does not create separate bill
-- rows per guest/party.
-- ============================================================
CREATE TABLE bill_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL UNIQUE REFERENCES bills(id) ON DELETE CASCADE,  -- at most one active split per bill

  split_type VARCHAR(10) NOT NULL,  -- 'even' | 'custom' — 'by_item' deferred, needs line-item-level UI
  num_parties INT NOT NULL,

  -- The guest session that requested the split — a real FK, not a
  -- loose device/session string, since guest_sessions already exists.
  requested_by_session_id UUID REFERENCES guest_sessions(id) ON DELETE SET NULL,
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_split_type CHECK (split_type IN ('even', 'custom')),
  CONSTRAINT chk_split_parties CHECK (num_parties >= 2)
);

CREATE TABLE bill_split_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  split_id UUID NOT NULL REFERENCES bill_splits(id) ON DELETE CASCADE,

  guest_label VARCHAR(50) NOT NULL,  -- e.g. "Guest 1", or a phone number if one was provided
  amount_owed DECIMAL(10, 2) NOT NULL,
  payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  paystack_reference VARCHAR(100),
  paid_at TIMESTAMP,

  CONSTRAINT chk_share_payment_status CHECK (payment_status IN ('pending', 'paid', 'failed'))
);

CREATE INDEX idx_shares_split ON bill_split_shares(split_id);
CREATE UNIQUE INDEX unique_share_paystack_reference ON bill_split_shares(paystack_reference) WHERE paystack_reference IS NOT NULL;

-- ============================================================
-- staff_calls — durable record of a guest asking for staff, not just a
-- fire-and-forget socket event. Scoped to 'payment' for now (Pay
-- Traditionally is the only guest action that triggers one) —
-- deliberately a small enum, not free-text, so it stays extensible
-- rather than open-ended.
-- ============================================================
CREATE TABLE staff_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  sitting_id UUID NOT NULL REFERENCES table_sittings(id) ON DELETE CASCADE,
  bill_id UUID REFERENCES bills(id) ON DELETE SET NULL,

  reason VARCHAR(20) NOT NULL DEFAULT 'payment',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TIMESTAMP,
  acknowledged_by UUID REFERENCES restaurant_staff(id) ON DELETE SET NULL,
  resolved_at TIMESTAMP,

  CONSTRAINT chk_staff_call_reason CHECK (reason IN ('payment')),
  CONSTRAINT chk_staff_call_status CHECK (status IN ('pending', 'acknowledged', 'resolved'))
);

CREATE INDEX idx_staff_calls_restaurant ON staff_calls(restaurant_id, status);
CREATE INDEX idx_staff_calls_table ON staff_calls(table_id);

-- ============================================================
-- guest_visits — the minimal guest-history capture layer. Reuses the
-- EXISTING guest_profiles table as the guest identity anchor (phone-
-- number-keyed, created on first order, migration 001) rather than
-- adding a new, near-duplicate `guests` table, which a second draft of
-- this design proposed without knowing guest_profiles already existed.
--
-- Note the scope this inherits from guest_profiles: it's scoped PER
-- RESTAURANT (guest_profiles.restaurant_id), so this captures repeat
-- visits to one restaurant, not a cross-restaurant guest identity —
-- true cross-restaurant history (in SNAPORDER's longer-term spec) needs
-- a platform-level identity above guest_profiles, which is a separate,
-- later decision, not assumed here.
-- ============================================================
CREATE TABLE guest_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_profile_id UUID REFERENCES guest_profiles(id) ON DELETE SET NULL,  -- NULL if the guest never placed an order this visit
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  sitting_id UUID NOT NULL UNIQUE REFERENCES table_sittings(id) ON DELETE CASCADE,
  bill_id UUID REFERENCES bills(id) ON DELETE SET NULL,

  total_spent DECIMAL(10, 2),  -- filled from bills.total_amount once the sitting's bill settles
  visited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_guest_visits_profile ON guest_visits(guest_profile_id);
CREATE INDEX idx_guest_visits_restaurant ON guest_visits(restaurant_id);

-- ============================================================
-- Attachment columns on existing tables — nullable for now (see the
-- top-of-file note on why NOT NULL would break current code/tests).
-- ============================================================
ALTER TABLE guest_sessions ADD COLUMN sitting_id UUID REFERENCES table_sittings(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN sitting_id UUID REFERENCES table_sittings(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN bill_id UUID REFERENCES bills(id) ON DELETE SET NULL;
ALTER TABLE payment_transactions ADD COLUMN bill_id UUID REFERENCES bills(id) ON DELETE SET NULL;
