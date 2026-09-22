import { pool } from '../db.js';

export async function insertOtp(restaurantId, phoneNumber, codeHash, expiresAt, executor = pool) {
  const result = await executor.query(
    `INSERT INTO guest_otp_verifications (restaurant_id, phone_number, code_hash, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id`,
    [restaurantId, phoneNumber, codeHash, expiresAt]
  );
  return result.rows[0].id;
}

/** @returns {Promise<object|null>} the most recent, still-open (not yet verified) OTP for this phone at this restaurant. */
export async function findLatestOpenOtp(restaurantId, phoneNumber, executor = pool) {
  const result = await executor.query(
    `SELECT id, code_hash, attempts, expires_at, verified_at
     FROM guest_otp_verifications
     WHERE restaurant_id = $1 AND phone_number = $2 AND verified_at IS NULL
     ORDER BY created_at DESC
     LIMIT 1`,
    [restaurantId, phoneNumber]
  );
  return result.rows[0] ?? null;
}

export async function incrementAttempts(id, executor = pool) {
  await executor.query(`UPDATE guest_otp_verifications SET attempts = attempts + 1 WHERE id = $1`, [id]);
}

export async function markVerified(id, executor = pool) {
  await executor.query(`UPDATE guest_otp_verifications SET verified_at = CURRENT_TIMESTAMP WHERE id = $1`, [id]);
}

/** @returns {Promise<boolean>} has this phone number ever been successfully verified at this restaurant? */
export async function isPhoneVerified(restaurantId, phoneNumber, executor = pool) {
  const result = await executor.query(
    `SELECT 1 FROM guest_otp_verifications WHERE restaurant_id = $1 AND phone_number = $2 AND verified_at IS NOT NULL LIMIT 1`,
    [restaurantId, phoneNumber]
  );
  return result.rows.length > 0;
}
