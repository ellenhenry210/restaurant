import { pool } from '../db.js';

// Same executor-parameter pattern as orderModel.js/paymentModel.js — lets
// billController.js run a multi-step write (e.g. create split + shares)
// as one transaction by passing its own checked-out client through.

/** @returns {Promise<{id, restaurant_id, table_id, sitting_id}|null>} the sitting a bill belongs to, or null if it's already closed/doesn't exist. */
export async function findOpenSittingByTable(tableId, executor = pool) {
  const result = await executor.query(
    `SELECT id, restaurant_id, table_id FROM table_sittings WHERE table_id = $1 AND status = 'open'`,
    [tableId]
  );
  return result.rows[0] ?? null;
}

export async function createSitting(restaurantId, tableId, executor = pool) {
  const result = await executor.query(
    `INSERT INTO table_sittings (restaurant_id, table_id) VALUES ($1, $2) RETURNING id, restaurant_id, table_id`,
    [restaurantId, tableId]
  );
  return result.rows[0];
}

/** @returns {Promise<object|null>} the one bill for a sitting, if one has been created yet. */
export async function findBillBySitting(sittingId, executor = pool) {
  const result = await executor.query(`SELECT * FROM bills WHERE sitting_id = $1`, [sittingId]);
  return result.rows[0] ?? null;
}

export async function findById(billId, executor = pool) {
  const result = await executor.query(`SELECT * FROM bills WHERE id = $1`, [billId]);
  return result.rows[0] ?? null;
}

/**
 * Totals every order in this sitting that isn't already attached to a
 * bill — this is what a newly-created bill covers. Deliberately
 * excludes already-billed orders, so a second bill for the same sitting
 * (shouldn't normally happen — one bill per sitting, enforced by a
 * unique constraint — but this keeps the query honest either way) never
 * double-counts.
 * @returns {Promise<{subtotal, tax, service_charge, tip_amount, total_amount, order_ids: string[]}>}
 */
export async function sumUnbilledOrders(sittingId, executor = pool) {
  const result = await executor.query(
    `SELECT id, subtotal, tax, service_charge, tip_amount
     FROM orders
     WHERE sitting_id = $1 AND bill_id IS NULL`,
    [sittingId]
  );
  const orders = result.rows;
  const sum = (field) => orders.reduce((total, o) => total + Number(o[field] ?? 0), 0);
  const subtotal = sum('subtotal');
  const tax = sum('tax');
  const serviceCharge = sum('service_charge');
  const tipAmount = sum('tip_amount');
  return {
    subtotal,
    tax,
    serviceCharge,
    tipAmount,
    totalAmount: subtotal + tax + serviceCharge,
    orderIds: orders.map((o) => o.id),
  };
}

export async function createBill(data, executor = pool) {
  const result = await executor.query(
    `INSERT INTO bills (sitting_id, restaurant_id, timing, status, subtotal, tax, service_charge, tip_amount, total_amount)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING *`,
    [
      data.sittingId,
      data.restaurantId,
      data.timing,
      data.status,
      data.subtotal,
      data.tax,
      data.serviceCharge,
      data.tipAmount,
      data.totalAmount,
    ]
  );
  return result.rows[0];
}

export async function attachOrdersToBill(orderIds, billId, executor = pool) {
  if (orderIds.length === 0) return;
  await executor.query(`UPDATE orders SET bill_id = $1 WHERE id = ANY($2::uuid[])`, [billId, orderIds]);
}

export async function updateBillStatus(billId, status, executor = pool) {
  await executor.query(`UPDATE bills SET status = $1 WHERE id = $2`, [status, billId]);
}

/** Any phone number attached to an order in this sitting — every order requires one at creation, so this is available as soon as at least one order exists. Used for the Paystack synthesized-email workaround, same as paymentModel.findOrderForPayment. */
export async function findAnyGuestPhoneForSitting(sittingId, executor = pool) {
  const result = await executor.query(
    `SELECT gp.phone_number
     FROM orders o
     JOIN guest_profiles gp ON gp.id = o.guest_profile_id
     WHERE o.sitting_id = $1
     LIMIT 1`,
    [sittingId]
  );
  return result.rows[0]?.phone_number ?? null;
}

// --- Splits ---

/** @returns {Promise<object|null>} the active split for a bill, if a split has been requested. */
export async function findSplitByBill(billId, executor = pool) {
  const result = await executor.query(`SELECT * FROM bill_splits WHERE bill_id = $1`, [billId]);
  return result.rows[0] ?? null;
}

export async function createSplit(data, executor = pool) {
  const result = await executor.query(
    `INSERT INTO bill_splits (bill_id, split_type, num_parties, requested_by_session_id)
     VALUES ($1, $2, $3, $4)
     RETURNING *`,
    [data.billId, data.splitType, data.numParties, data.requestedBySessionId]
  );
  return result.rows[0];
}

export async function insertShares(splitId, shares, executor = pool) {
  const inserted = [];
  for (const share of shares) {
    const result = await executor.query(
      `INSERT INTO bill_split_shares (split_id, guest_label, amount_owed) VALUES ($1, $2, $3) RETURNING *`,
      [splitId, share.guestLabel, share.amountOwed]
    );
    inserted.push(result.rows[0]);
  }
  return inserted;
}

export async function findSharesBySplit(splitId, executor = pool) {
  const result = await executor.query(`SELECT * FROM bill_split_shares WHERE split_id = $1 ORDER BY created_at ASC`, [splitId]);
  return result.rows;
}

/**
 * A share plus enough of its parent bill/split to authorize and price a
 * payment against it in one round trip.
 * @returns {Promise<object|null>} { id, split_id, guest_label, amount_owed, payment_status, bill_id, sitting_id, restaurant_id, bill_status, bill_timing }
 */
export async function findShareForPayment(shareId, executor = pool) {
  const result = await executor.query(
    `SELECT s.id, s.split_id, s.guest_label, s.amount_owed, s.payment_status,
            b.id AS bill_id, b.sitting_id, b.restaurant_id, b.status AS bill_status, b.timing AS bill_timing
     FROM bill_split_shares s
     JOIN bill_splits sp ON sp.id = s.split_id
     JOIN bills b ON b.id = sp.bill_id
     WHERE s.id = $1`,
    [shareId]
  );
  return result.rows[0] ?? null;
}

export async function setShareReference(shareId, reference, executor = pool) {
  await executor.query(`UPDATE bill_split_shares SET paystack_reference = $1 WHERE id = $2`, [reference, shareId]);
}

// --- Staff calls ---

export async function createStaffCall(data, executor = pool) {
  const result = await executor.query(
    `INSERT INTO staff_calls (restaurant_id, table_id, sitting_id, bill_id, reason)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING *`,
    [data.restaurantId, data.tableId, data.sittingId, data.billId, data.reason ?? 'payment']
  );
  return result.rows[0];
}

export async function findStaffCalls(restaurantId, statusFilter, executor = pool) {
  const result = await executor.query(
    `SELECT * FROM staff_calls WHERE restaurant_id = $1 AND ($2::text IS NULL OR status = $2) ORDER BY created_at ASC`,
    [restaurantId, statusFilter ?? null]
  );
  return result.rows;
}

export async function findStaffCallById(restaurantId, callId, executor = pool) {
  const result = await executor.query(`SELECT * FROM staff_calls WHERE id = $1 AND restaurant_id = $2`, [callId, restaurantId]);
  return result.rows[0] ?? null;
}

export async function updateStaffCallStatus(callId, status, staffId, executor = pool) {
  const column = status === 'acknowledged' ? 'acknowledged_at' : 'resolved_at';
  const extra = status === 'acknowledged' ? ', acknowledged_by = $3' : '';
  const result = await executor.query(
    `UPDATE staff_calls SET status = $1, ${column} = CURRENT_TIMESTAMP${extra} WHERE id = $2 RETURNING *`,
    status === 'acknowledged' ? [status, callId, staffId] : [status, callId]
  );
  return result.rows[0];
}

// --- Payment webhook cascade (bill/share side — see paymentController.handleWebhook) ---

/**
 * Resolves a Paystack webhook event for a bill-level transaction — the
 * bill-side counterpart to paymentModel.markTransactionResolved. Handles
 * both a whole-bill payment and a per-share payment: the reference is
 * looked up against bill_split_shares first (unique-indexed), and if it
 * matches, only that share (and, once every sibling share is paid, the
 * parent bill) is updated; otherwise this was a whole-bill payment and
 * the bill itself is updated directly.
 */
export async function resolveBillTransaction({ transactionId, billId, reference, status, gatewayResponse }, executor = pool) {
  const paidAt = status === 'success' ? new Date() : null;
  await executor.query(
    `UPDATE payment_transactions
     SET status = $1, gateway_response = $2, paid_at = COALESCE($3, paid_at), updated_at = CURRENT_TIMESTAMP
     WHERE id = $4`,
    [status, gatewayResponse, paidAt, transactionId]
  );

  const shareResult = await executor.query(`SELECT id, split_id FROM bill_split_shares WHERE paystack_reference = $1`, [reference]);
  const share = shareResult.rows[0];

  if (status !== 'success') {
    if (share) {
      await executor.query(`UPDATE bill_split_shares SET payment_status = 'failed' WHERE id = $1`, [share.id]);
    }
    // A failed whole-bill attempt leaves the bill in 'awaiting_payment' —
    // the guest can retry, no state to unwind.
    return;
  }

  if (share) {
    await executor.query(`UPDATE bill_split_shares SET payment_status = 'paid', paid_at = CURRENT_TIMESTAMP WHERE id = $1`, [share.id]);
    const remaining = await executor.query(
      `SELECT COUNT(*)::int AS n FROM bill_split_shares WHERE split_id = $1 AND payment_status != 'paid'`,
      [share.split_id]
    );
    if (remaining.rows[0].n === 0) {
      await executor.query(`UPDATE bills SET status = 'paid', settled_at = CURRENT_TIMESTAMP WHERE id = $1`, [billId]);
    }
  } else {
    await executor.query(`UPDATE bills SET status = 'paid', settled_at = CURRENT_TIMESTAMP WHERE id = $1`, [billId]);
  }
}
