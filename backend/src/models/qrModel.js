import { pool } from '../db.js';

/** @returns {Promise<{id, table_number, qr_code_unique_id, qr_code_url}|null>} */
export async function findTableByNumber(restaurantId, tableNumber, executor = pool) {
  const result = await executor.query(
    `SELECT id, table_number, qr_code_unique_id, qr_code_url FROM tables WHERE restaurant_id = $1 AND table_number = $2`,
    [restaurantId, tableNumber]
  );
  return result.rows[0] ?? null;
}

/** Cache the deep-link a table's QR currently encodes — see qrController.js for what that link is and why. */
export async function saveQrCodeUrl(tableId, qrCodeUrl, executor = pool) {
  await executor.query(`UPDATE tables SET qr_code_url = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2`, [qrCodeUrl, tableId]);
}

/**
 * Replaces a table's qr_code_unique_id with a fresh random token and
 * resets qr_rotated_at — the old, possibly-leaked code stops resolving
 * at all the instant this commits (POST /v1/tables/:qrCodeId/scan looks
 * it up by exact match). qr_code_url is cleared, not recomputed here —
 * the next GET .../qr/:restaurantId/:tableNumber regenerates and caches
 * it against the new token, same as it does for a brand-new table.
 * @returns {Promise<{id, qr_code_unique_id}>}
 */
export async function rotateQrCode(tableId, newCode, executor = pool) {
  const result = await executor.query(
    `UPDATE tables
     SET qr_code_unique_id = $1, qr_code_url = NULL, qr_rotated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $2
     RETURNING id, qr_code_unique_id`,
    [newCode, tableId]
  );
  return result.rows[0];
}
