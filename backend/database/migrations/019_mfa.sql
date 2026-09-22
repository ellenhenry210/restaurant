-- 019_mfa.sql
--
-- TOTP-based MFA, restricted (at the application layer, in
-- routes/auth.js) to Owner and System Admin — the PAM requirement in
-- SNAPORDER_AUTHORIZATION.md Part 7 for high-privilege accounts, not
-- something every staff member is asked to set up. mfa_secret is
-- written as soon as setup starts (an "unconfirmed" secret) and
-- mfa_enabled only flips to TRUE once the user proves they actually
-- have it (verify-setup) — this mirrors the reasoning behind
-- guest_sessions/refresh_tokens being real rows: an in-progress setup
-- that's never confirmed just sits there unused, harmlessly.

ALTER TABLE users
  ADD COLUMN mfa_secret VARCHAR(64),
  ADD COLUMN mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE;
