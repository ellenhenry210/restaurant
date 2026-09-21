import crypto from 'node:crypto';

import { pool } from '../db.js';
import * as billModel from '../models/billModel.js';
import { initializeTransaction } from '../paystack.js';
import { emitWaiterCalled } from '../realtime.js';

const TIMINGS = ['pay_now', 'pay_after', 'pay_traditional'];
const NON_PAYABLE_BILL_STATUSES = ['split_requested', 'paid', 'settled_traditionally', 'cancelled'];

function billOwnedBySession(bill, guestSession) {
  return bill.sitting_id === guestSession.sitting_id;
}

// ---------------------------------------------------------------------
// POST /guest/session/bill — get-or-create THE ONE bill for the caller's
// table's current sitting. Idempotent: a second call for the same
// sitting returns the existing bill rather than creating another (bills
// has a UNIQUE(sitting_id) constraint, so a naive re-insert would just
// fail — this checks first instead of relying on that to reject it).
// ---------------------------------------------------------------------
export async function create(req, res) {
  const { timing } = req.body ?? {};
  if (!TIMINGS.includes(timing)) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: `timing must be one of: ${TIMINGS.join(', ')}` },
    });
  }

  const { sitting_id: sittingId, restaurant_id: restaurantId, table_id: tableId } = req.guestSession;
  if (!sittingId) {
    // A session issued before this feature existed (or, in principle, a
    // bug in the scan route) — the fix is a fresh scan, not something
    // this endpoint can repair for an already-issued token.
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'Your session needs to be refreshed — please scan the table\'s QR code again' },
    });
  }

  try {
    const existing = await billModel.findBillBySitting(sittingId);
    if (existing) {
      return res.status(200).json(existing);
    }

    const totals = await billModel.sumUnbilledOrders(sittingId);
    if (totals.orderIds.length === 0) {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'There are no orders to bill yet' } });
    }

    const client = await pool.connect();
    let bill;
    try {
      await client.query('BEGIN');
      bill = await billModel.createBill(
        {
          sittingId,
          restaurantId,
          timing,
          status: timing === 'pay_traditional' ? 'awaiting_payment' : 'open',
          subtotal: totals.subtotal,
          tax: totals.tax,
          serviceCharge: totals.serviceCharge,
          tipAmount: totals.tipAmount,
          totalAmount: totals.totalAmount,
        },
        client
      );
      await billModel.attachOrdersToBill(totals.orderIds, bill.id, client);

      if (timing === 'pay_traditional') {
        await billModel.createStaffCall(
          { restaurantId, tableId, sittingId, billId: bill.id, reason: 'payment' },
          client
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    if (timing === 'pay_traditional') {
      try {
        emitWaiterCalled(restaurantId, { table_id: tableId, bill_id: bill.id, reason: 'payment' });
      } catch (err) {
        console.error('emitWaiterCalled failed (bill/staff call were still created successfully):', err.message);
      }
    }

    res.status(201).json(bill);
  } catch (err) {
    console.error('POST /guest/session/bill: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create bill' } });
  }
}

// ---------------------------------------------------------------------
// GET /guest/session/bill/:billId
// ---------------------------------------------------------------------
export async function getOne(req, res) {
  try {
    const bill = await billModel.findById(req.params.billId);
    if (!bill) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    if (!billOwnedBySession(bill, req.guestSession)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This bill does not belong to your table' } });
    }
    res.json(bill);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    console.error('GET /guest/session/bill/:billId: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load bill' } });
  }
}

function computeEvenShares(totalAmount, numParties) {
  // Cents, not float division — otherwise a total like 1000/3 produces
  // shares that don't re-sum to exactly the original total.
  const totalCents = Math.round(Number(totalAmount) * 100);
  const base = Math.floor(totalCents / numParties);
  const remainder = totalCents - base * numParties;
  return Array.from({ length: numParties }, (_, i) => ({
    guestLabel: `Guest ${i + 1}`,
    // The first `remainder` shares absorb the leftover cent(s) — an
    // arbitrary but consistent choice, not "unfair" in any way that
    // matters at the sub-naira level this applies to.
    amountOwed: (base + (i < remainder ? 1 : 0)) / 100,
  }));
}

function validateSplitInput(body) {
  const errors = [];
  if (!['even', 'custom'].includes(body.split_type)) {
    errors.push({ field: 'split_type', reason: "must be 'even' or 'custom'" });
  }
  if (!Number.isInteger(body.num_parties) || body.num_parties < 2) {
    errors.push({ field: 'num_parties', reason: 'must be an integer of 2 or more' });
  }
  if (body.split_type === 'custom') {
    if (!Array.isArray(body.shares) || body.shares.length !== body.num_parties) {
      errors.push({ field: 'shares', reason: 'required for a custom split, with exactly num_parties entries' });
    } else {
      body.shares.forEach((share, i) => {
        if (!share.guest_label || typeof share.guest_label !== 'string') {
          errors.push({ field: `shares[${i}].guest_label`, reason: 'required' });
        }
        if (typeof share.amount_owed !== 'number' || share.amount_owed <= 0) {
          errors.push({ field: `shares[${i}].amount_owed`, reason: 'must be a positive number' });
        }
      });
    }
  }
  return errors;
}

// ---------------------------------------------------------------------
// POST /bills/:billId/request-split — the only path that creates a
// split; nothing does this automatically. Moves the bill's status to
// 'split_requested', which the payment-initialize endpoints below check
// to enforce "once split, pay per-share, not as a whole" (409).
// ---------------------------------------------------------------------
export async function requestSplit(req, res) {
  const { billId } = req.params;
  const body = req.body ?? {};
  const errors = validateSplitInput(body);
  if (errors.length > 0) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'One or more fields are invalid', details: errors } });
  }

  try {
    const bill = await billModel.findById(billId);
    if (!bill) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    if (!billOwnedBySession(bill, req.guestSession)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This bill does not belong to your table' } });
    }
    if (NON_PAYABLE_BILL_STATUSES.includes(bill.status)) {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: `A split can't be requested — this bill is already '${bill.status}'` },
      });
    }

    let shares;
    if (body.split_type === 'even') {
      shares = computeEvenShares(bill.total_amount, body.num_parties);
    } else {
      const sumCents = Math.round(body.shares.reduce((sum, s) => sum + s.amount_owed, 0) * 100);
      const totalCents = Math.round(Number(bill.total_amount) * 100);
      if (sumCents !== totalCents) {
        return res.status(400).json({
          error: {
            code: 'INVALID_REQUEST',
            message: `shares must sum to the bill's total_amount (${bill.total_amount}), got ${(sumCents / 100).toFixed(2)}`,
          },
        });
      }
      shares = body.shares.map((s) => ({ guestLabel: s.guest_label, amountOwed: s.amount_owed }));
    }

    const client = await pool.connect();
    let split, insertedShares;
    try {
      await client.query('BEGIN');
      split = await billModel.createSplit(
        { billId, splitType: body.split_type, numParties: body.num_parties, requestedBySessionId: req.guestSession.id },
        client
      );
      insertedShares = await billModel.insertShares(split.id, shares, client);
      await billModel.updateBillStatus(billId, 'split_requested', client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({ ...split, shares: insertedShares });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    // unique_bill_per_sitting-style race: two near-simultaneous
    // request-split calls for the same bill (bill_splits.bill_id is
    // UNIQUE) — the loser gets a clear conflict, not a raw DB error.
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'A split has already been requested for this bill' } });
    }
    console.error('POST /bills/:billId/request-split: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to request split' } });
  }
}

// ---------------------------------------------------------------------
// GET /bills/:billId/splits
// ---------------------------------------------------------------------
export async function getSplits(req, res) {
  try {
    const bill = await billModel.findById(req.params.billId);
    if (!bill) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    if (!billOwnedBySession(bill, req.guestSession)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This bill does not belong to your table' } });
    }

    const split = await billModel.findSplitByBill(bill.id);
    if (!split) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No split has been requested for this bill' } });
    }
    const shares = await billModel.findSharesBySplit(split.id);
    res.json({ ...split, shares });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    console.error('GET /bills/:billId/splits: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load splits' } });
  }
}

function synthesizeEmail(phoneNumber, fallbackId) {
  return phoneNumber
    ? `${phoneNumber.replace(/[^0-9+]/g, '')}@guest.snaporder.app`
    : `guest-${fallbackId}@guest.snaporder.app`;
}

// ---------------------------------------------------------------------
// POST /bills/:billId/payments/initialize — the default, whole-bill
// payment path. Blocked (409) the instant a split has been requested —
// see requestSplit above — and rejected (400) for a pay_traditional
// bill, which never touches Paystack at all.
// ---------------------------------------------------------------------
export async function initializeBillPayment(req, res) {
  const { billId } = req.params;

  try {
    const bill = await billModel.findById(billId);
    if (!bill) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    if (!billOwnedBySession(bill, req.guestSession)) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This bill does not belong to your table' } });
    }
    if (bill.timing === 'pay_traditional') {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'This bill is set to be paid in person, not through Paystack' } });
    }
    if (NON_PAYABLE_BILL_STATUSES.includes(bill.status)) {
      const message =
        bill.status === 'split_requested'
          ? 'A split has been requested for this bill — pay via your individual share instead'
          : bill.status === 'paid'
            ? 'This bill has already been paid'
            : `This bill can't be paid (status: ${bill.status})`;
      return res.status(409).json({ error: { code: 'CONFLICT', message } });
    }

    const grandTotal = Number(bill.total_amount) + Number(bill.tip_amount);
    const amountKobo = Math.round(grandTotal * 100);
    const reference = `snap_bill_${crypto.randomBytes(12).toString('hex')}`;
    const phone = await billModel.findAnyGuestPhoneForSitting(bill.sitting_id);
    const email = synthesizeEmail(phone, bill.id);

    const paystackData = await initializeTransaction({
      email,
      amountKobo,
      reference,
      callbackUrl: typeof req.body?.callback_url === 'string' ? req.body.callback_url : undefined,
      metadata: { bill_id: bill.id, restaurant_id: bill.restaurant_id },
    });

    const client = await pool.connect();
    let transaction;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO payment_transactions (bill_id, restaurant_id, reference, amount, currency, status, authorization_url)
         VALUES ($1, $2, $3, $4, $5, 'pending', $6)
         RETURNING id, reference, amount, currency, status, authorization_url`,
        [bill.id, bill.restaurant_id, reference, grandTotal, bill.currency, paystackData.authorization_url]
      );
      transaction = inserted.rows[0];
      await billModel.updateBillStatus(bill.id, 'awaiting_payment', client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({
      reference: transaction.reference,
      authorization_url: transaction.authorization_url,
      amount: transaction.amount,
      currency: transaction.currency,
      status: transaction.status,
    });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Bill not found' } });
    }
    console.error('POST /bills/:billId/payments/initialize: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to initialize payment' } });
  }
}

// ---------------------------------------------------------------------
// POST /bills/splits/:shareId/payments/initialize — same Paystack flow,
// scoped to one share's amount_owed. The webhook (paymentController.js
// -> billModel.resolveBillTransaction) is what cascades the parent bill
// to 'paid' once every sibling share is paid.
// ---------------------------------------------------------------------
export async function initializeSharePayment(req, res) {
  const { shareId } = req.params;

  try {
    const share = await billModel.findShareForPayment(shareId);
    if (!share) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Share not found' } });
    }
    if (share.sitting_id !== req.guestSession.sitting_id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This share does not belong to your table' } });
    }
    if (share.payment_status === 'paid') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'This share has already been paid' } });
    }
    if (['paid', 'settled_traditionally', 'cancelled'].includes(share.bill_status)) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: `This bill can't be paid (status: ${share.bill_status})` } });
    }

    const amountKobo = Math.round(Number(share.amount_owed) * 100);
    const reference = `snap_split_${crypto.randomBytes(12).toString('hex')}`;
    const phone = await billModel.findAnyGuestPhoneForSitting(share.sitting_id);
    const email = synthesizeEmail(phone, share.id);

    const paystackData = await initializeTransaction({
      email,
      amountKobo,
      reference,
      callbackUrl: typeof req.body?.callback_url === 'string' ? req.body.callback_url : undefined,
      metadata: { bill_id: share.bill_id, share_id: share.id, restaurant_id: share.restaurant_id },
    });

    const client = await pool.connect();
    let transaction;
    try {
      await client.query('BEGIN');
      const inserted = await client.query(
        `INSERT INTO payment_transactions (bill_id, restaurant_id, reference, amount, currency, status, authorization_url)
         VALUES ($1, $2, $3, $4, 'NGN', 'pending', $5)
         RETURNING id, reference, amount, currency, status, authorization_url`,
        [share.bill_id, share.restaurant_id, reference, share.amount_owed, paystackData.authorization_url]
      );
      transaction = inserted.rows[0];
      await billModel.setShareReference(share.id, reference, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(201).json({
      reference: transaction.reference,
      authorization_url: transaction.authorization_url,
      amount: transaction.amount,
      currency: transaction.currency,
      status: transaction.status,
    });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Share not found' } });
    }
    console.error('POST /bills/splits/:shareId/payments/initialize: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to initialize payment' } });
  }
}
