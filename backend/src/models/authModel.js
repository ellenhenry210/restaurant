import { pool } from '../db.js';

// New queries for routes/auth.js's refresh-token, password-reset, and
// MFA endpoints — split into a model here (rather than adding more
// inline pool.query calls to routes/auth.js) per this project's default
// for new work: any brand-new resource gets the controller/model split.
// register/login themselves stay inline in routes/auth.js, unchanged —
// this only covers what's new.

// --- Refresh tokens ---

export async function insertRefreshToken(userId, tokenHash, expiresAt, executor = pool) {
  await executor.query(`INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    userId,
    tokenHash,
    expiresAt,
  ]);
}

/** @returns {Promise<{id, user_id, expires_at, revoked_at}|null>} */
export async function findRefreshTokenByHash(tokenHash, executor = pool) {
  const result = await executor.query(
    `SELECT id, user_id, expires_at, revoked_at FROM refresh_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

export async function revokeRefreshToken(id, executor = pool) {
  await executor.query(`UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
}

/** Revoke every refresh token a user holds — used on password reset, so a stolen-but-still-valid session doesn't survive it. */
export async function revokeAllRefreshTokensForUser(userId, executor = pool) {
  await executor.query(
    `UPDATE refresh_tokens SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = $1 AND revoked_at IS NULL`,
    [userId]
  );
}

// --- Password reset ---

export async function findUserByEmail(email, executor = pool) {
  const result = await executor.query(`SELECT id, email, password_hash FROM users WHERE email = $1`, [email]);
  return result.rows[0] ?? null;
}

export async function insertPasswordResetToken(userId, tokenHash, expiresAt, executor = pool) {
  await executor.query(`INSERT INTO password_reset_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)`, [
    userId,
    tokenHash,
    expiresAt,
  ]);
}

/** @returns {Promise<{id, user_id, expires_at, used_at}|null>} */
export async function findPasswordResetTokenByHash(tokenHash, executor = pool) {
  const result = await executor.query(
    `SELECT id, user_id, expires_at, used_at FROM password_reset_tokens WHERE token_hash = $1`,
    [tokenHash]
  );
  return result.rows[0] ?? null;
}

export async function markPasswordResetTokenUsed(id, executor = pool) {
  await executor.query(`UPDATE password_reset_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
}

export async function updateUserPassword(userId, passwordHash, executor = pool) {
  await executor.query(`UPDATE users SET password_hash = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [
    passwordHash,
    userId,
  ]);
}

// --- MFA ---

/** @returns {Promise<{id, email, password_hash, mfa_secret, mfa_enabled}|null>} */
export async function findUserForMfa(userId, executor = pool) {
  const result = await executor.query(
    `SELECT id, email, password_hash, mfa_secret, mfa_enabled FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function setPendingMfaSecret(userId, secret, executor = pool) {
  await executor.query(`UPDATE users SET mfa_secret = $1, mfa_enabled = FALSE WHERE id = $2`, [secret, userId]);
}

export async function enableMfa(userId, executor = pool) {
  await executor.query(`UPDATE users SET mfa_enabled = TRUE WHERE id = $1`, [userId]);
}

export async function disableMfa(userId, executor = pool) {
  await executor.query(`UPDATE users SET mfa_enabled = FALSE, mfa_secret = NULL WHERE id = $1`, [userId]);
}

/**
 * The PAM gate for MFA setup (SNAPORDER_AUTHORIZATION.md Part 7): true
 * if this user is an Owner at any restaurant, or a System Admin.
 * Everyone else (manager/waiter/kitchen_staff) can't enable/be asked for
 * MFA — it's not a general staff feature, it's specifically for
 * high-privilege accounts.
 * @returns {Promise<boolean>}
 */
export async function isPrivilegedForMfa(userId, executor = pool) {
  const result = await executor.query(
    `SELECT
       EXISTS(SELECT 1 FROM restaurant_staff WHERE user_id = $1 AND role = 'owner' AND is_active = TRUE) AS is_owner,
       EXISTS(SELECT 1 FROM platform_admins WHERE user_id = $1) AS is_platform_admin`,
    [userId]
  );
  const row = result.rows[0];
  return row.is_owner || row.is_platform_admin;
}
