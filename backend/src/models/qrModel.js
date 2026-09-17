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
