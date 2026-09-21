import { pool } from '../db.js';

/** Order row needed to price and authorize a payment — mirrors the shape orderModel.findById() already returns, plus guest_profile_id's phone for the Paystack email workaround. */
export async function findOrderForPayment(orderId, executor = pool) {
  const result = await executor.query(
    `SELECT o.id, o.restaurant_id, o.table_id, o.status, o.payment_status,
            o.total_amount, o.tip_amount, o.currency,
            gp.phone_number
     FROM orders o
     LEFT JOIN guest_profiles gp ON gp.id = o.guest_profile_id
     WHERE o.id = $1`,
    [orderId]
  );
  return result.rows[0] ?? null;
}

export async function insertTransaction(data, executor = pool) {
  const result = await executor.query(
    `INSERT INTO payment_transactions (order_id, restaurant_id, reference, amount, currency, status, authorization_url)
     VALUES ($1, $2, $3, $4, $5, 'pending', $6)
     RETURNING id, reference, amount, currency, status, authorization_url, created_at`,
    [data.orderId, data.restaurantId, data.reference, data.amount, data.currency, data.authorizationUrl]
  );
  return result.rows[0];
}

export async function findTransactionByReference(reference, executor = pool) {
  const result = await executor.query(
    `SELECT id, order_id, bill_id, restaurant_id, reference, amount, status FROM payment_transactions WHERE reference = $1`,
    [reference]
  );
  return result.rows[0] ?? null;
}

/**
 * Record the webhook's outcome and, on success, mark the order paid — one
 * transaction, so a crash between the two updates can't leave a
 * "succeeded" payment_transactions row next to a still-"pending" order.
 */
export async function markTransactionResolved({ transactionId, orderId, status, gatewayResponse }, executor = pool) {
  // paidAt computed in JS, not via a second `$1 = 'success'` comparison in
  // SQL — reusing one placeholder as both an assigned value and a
  // comparison target makes Postgres unable to deduce a single type for
  // it ("inconsistent types deduced for parameter $1").
  const paidAt = status === 'success' ? new Date() : null;
  await executor.query(
    `UPDATE payment_transactions
     SET status = $1, gateway_response = $2, paid_at = COALESCE($3, paid_at), updated_at = CURRENT_TIMESTAMP
     WHERE id = $4`,
    [status, gatewayResponse, paidAt, transactionId]
  );

  if (status === 'success') {
    await executor.query(
      `UPDATE orders SET payment_status = 'completed', payment_reference = (SELECT reference FROM payment_transactions WHERE id = $2), updated_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [orderId, transactionId]
    );
  } else if (status === 'failed') {
    await executor.query(`UPDATE orders SET payment_status = 'failed', updated_at = CURRENT_TIMESTAMP WHERE id = $1`, [orderId]);
  }
}
