-- 014_bill_payments_schema_fix.sql
--
-- Two small corrections found while wiring the actual route/controller
-- layer for migration 013's billing tables (schema-only until now):
--
-- 1. payment_transactions.order_id is NOT NULL (migration 010), but a
--    bill-level payment (POST /v1/bills/:billId/payments/initialize or
--    .../splits/:shareId/payments/initialize) covers a whole bill —
--    potentially several orders — not one single order, so there's no
--    one order_id to put there. Loosened to nullable; a CHECK constraint
--    keeps every row anchored to at least one of order_id/bill_id, so
--    this can't silently become "neither" by mistake. Purely additive —
--    every existing row already has order_id set, so nothing is
--    invalidated.
-- 2. bills was missing a `currency` column — every other money-bearing
--    table (orders, payment_transactions) has one, defaulting 'NGN'.
--    Straightforward oversight in the original design pass.

ALTER TABLE payment_transactions ALTER COLUMN order_id DROP NOT NULL;
ALTER TABLE payment_transactions ADD CONSTRAINT chk_payment_transactions_target CHECK (order_id IS NOT NULL OR bill_id IS NOT NULL);

ALTER TABLE bills ADD COLUMN currency VARCHAR(3) DEFAULT 'NGN';
