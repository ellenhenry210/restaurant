-- ============================================================
-- 010. payment_transactions
-- ============================================================
-- Records every Paystack initialize attempt, not just successful ones —
-- an abandoned or failed transaction is still worth keeping (support
-- needs to see "guest tried to pay and it failed" as distinct from
-- "guest never tried"). orders.payment_status/payment_reference
-- (migration 001) remain the source of truth for "is this order paid",
-- updated by the webhook handler when a transaction here succeeds; this
-- table is the full history behind that single current value.
CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  reference VARCHAR(100) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',

  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  gateway VARCHAR(20) NOT NULL DEFAULT 'paystack',
  authorization_url TEXT,
  gateway_response JSONB,
  paid_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_payment_transactions_status CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
  CONSTRAINT unique_payment_reference UNIQUE (reference)
);

CREATE INDEX idx_payment_transactions_order ON payment_transactions(order_id);
CREATE INDEX idx_payment_transactions_restaurant ON payment_transactions(restaurant_id);
