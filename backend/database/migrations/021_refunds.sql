-- 021_refunds.sql
--
-- Closes a flagged gap: issue_refund has been a real permission in the
-- matrix since day one, but neither bills nor payment_transactions had
-- a 'refunded' state to move into. Widening both CHECK constraints
-- (additive, no existing row is invalidated) rather than repurposing
-- 'cancelled' — a refund is a distinct, audit-worthy event from a bill
-- that was simply never paid.

ALTER TABLE bills DROP CONSTRAINT chk_bill_status;
ALTER TABLE bills ADD CONSTRAINT chk_bill_status CHECK (status IN (
  'open', 'split_requested', 'awaiting_payment', 'paid', 'settled_traditionally', 'cancelled', 'refunded'
));
ALTER TABLE bills ADD COLUMN refunded_at TIMESTAMP;

ALTER TABLE payment_transactions DROP CONSTRAINT chk_payment_transactions_status;
ALTER TABLE payment_transactions ADD CONSTRAINT chk_payment_transactions_status CHECK (status IN (
  'pending', 'success', 'failed', 'abandoned', 'refunded'
));

-- A refund deserves its own audit_log action — reusing 'order_cancelled'
-- for it would blur two genuinely different events (an order never
-- fulfilled vs. money actually returned).
ALTER TABLE audit_log DROP CONSTRAINT chk_audit_action;
ALTER TABLE audit_log ADD CONSTRAINT chk_audit_action CHECK (action IN (
  'order_placed', 'order_cancelled', 'menu_updated',
  'inventory_updated', 'review_posted', 'staff_login',
  'authz_denied', 'guest_session_revoked', 'refund_issued'
));
