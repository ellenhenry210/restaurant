-- 018_password_reset_tokens.sql
--
-- Same hashed-token-row pattern as refresh_tokens (migration 017): the
-- raw token is only ever held by the requester (in the real product,
-- delivered by email — no email provider is wired up yet, see
-- SNAPORDER_STATUS.md, so today it's logged server-side instead of
-- actually delivered). used_at makes a token single-use: checked on
-- every reset attempt, set the moment one succeeds.

CREATE TABLE password_reset_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash VARCHAR(64) NOT NULL UNIQUE,

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,
  used_at TIMESTAMP
);

CREATE INDEX idx_password_reset_tokens_user ON password_reset_tokens(user_id);
