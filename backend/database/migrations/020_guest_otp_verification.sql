-- 020_guest_otp_verification.sql
--
-- Closes a real, previously-unflagged gap: a guest can currently claim
-- any phone number at checkout with nothing checking it's actually
-- theirs. This is the verification MECHANISM only — a 6-digit code,
-- hashed (never stored raw, same reasoning as refresh_tokens/password_
-- reset_tokens), attempt-limited against brute force, expiring quickly
-- since it's short and low-entropy compared to those other token types.
--
-- Deliberately NOT wired into order creation or any other flow yet —
-- requiring verification before ordering is a product decision (it adds
-- friction to the guest checkout path this project has otherwise kept
-- deliberately frictionless), not something to force through as a side
-- effect of a security pass. This just makes verification possible.

CREATE TABLE guest_otp_verifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  phone_number VARCHAR(20) NOT NULL,

  code_hash VARCHAR(64) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  verified_at TIMESTAMP,

  CONSTRAINT chk_otp_attempts CHECK (attempts >= 0)
);

CREATE INDEX idx_guest_otp_lookup ON guest_otp_verifications(restaurant_id, phone_number);
