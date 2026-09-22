-- 017_refresh_tokens.sql
--
-- Closes a flagged gap: only short-lived access tokens existed, so a
-- staff member had to fully re-login every time one expired. A refresh
-- token is opaque (a random value, not a JWT) and DB-backed, not just
-- longer-lived — the same reasoning as guest_sessions being a real row
-- rather than a bare stateless token: it gives a place to revoke one
-- early (logout, a detected compromise) that takes effect immediately,
-- which a purely stateless long-lived JWT could never do.
--
-- Only the SHA-256 hash of the token is stored, never the raw value —
-- the same principle as password_hash: a leaked database row shouldn't
-- hand out a usable credential.

CREATE TABLE refresh_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  revoked_at TIMESTAMP
);

CREATE INDEX idx_refresh_tokens_user ON refresh_tokens(user_id);
