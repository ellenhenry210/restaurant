import crypto from 'node:crypto';

import { pool } from '../db.js';
import * as paymentModel from '../models/paymentModel.js';
import * as billModel from '../models/billModel.js';
import { initializeTransaction, verifyWebhookSignature } from '../paystack.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------
// POST /v1/orders/:id/payments/initialize
//
// Behind authenticateGuest, same ownership pattern as
// orderController.getStatus — a guest can only pay for an order at their
// own table, not any order id they happen to guess.
//
// Paystack requires an `email` field; guests never provide one (phone-
// only, see guest_profiles). A synthesized address
// (`<phone>@guest.snaporder.app`) is the standard workaround for
// phone-only checkout flows on Paystack — it's never actually mailed to,
// just satisfies the required field.
// ---------------------------------------------------------------------
export async function initialize(req, res) {
  const { id: orderId } = req.params;

  try {
    const order = await paymentModel.findOrderForPayment(orderId);
    if (!order) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    if (order.table_id !== req.guestSession.table_id || order.restaurant_id !== req.guestSession.restaurant_id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This order does not belong to your table' } });
    }
    if (order.payment_status === 'completed') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'This order has already been paid' } });
    }

    const grandTotal = Number(order.total_amount) + Number(order.tip_amount);
    const amountKobo = Math.round(grandTotal * 100);
    const reference = `snap_${crypto.randomBytes(12).toString('hex')}`;
    const email = order.phone_number
      ? `${order.phone_number.replace(/[^0-9+]/g, '')}@guest.snaporder.app`
      : `guest-${orderId}@guest.snaporder.app`;

    const paystackData = await initializeTransaction({
      email,
      amountKobo,
      reference,
      callbackUrl: typeof req.body?.callback_url === 'string' ? req.body.callback_url : undefined,
      metadata: { order_id: order.id, restaurant_id: order.restaurant_id },
    });

    const transaction = await paymentModel.insertTransaction({
      orderId: order.id,
      restaurantId: order.restaurant_id,
      reference,
      amount: grandTotal,
      currency: order.currency,
      authorizationUrl: paystackData.authorization_url,
    });

    res.status(201).json({
      reference: transaction.reference,
      authorization_url: transaction.authorization_url,
      amount: transaction.amount,
      currency: transaction.currency,
      status: transaction.status,
    });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    logger.error(`POST /orders/:id/payments/initialize: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to initialize payment' } });
  }
}

// ---------------------------------------------------------------------
// POST /v1/payments/webhook — Paystack calls this directly, with no
// guest/staff session at all. The HMAC signature IS the authentication
// here; there is no other check. Mounted (in index.js) with
// express.raw() BEFORE the app-wide express.json(), so req.body is the
// exact byte buffer Paystack signed — re-parsing to JSON and
// re-serializing before verifying would produce a different hash and
// reject every real webhook.
//
// Always acknowledges with 200 once the signature is valid, even for an
// event this code doesn't otherwise act on (Paystack retries on
// non-2xx, and retried floods of an event we already handled — or never
// will — help no one).
// ---------------------------------------------------------------------
export async function handleWebhook(req, res) {
  const signature = req.headers['x-paystack-signature'];

  if (!Buffer.isBuffer(req.body) || !verifyWebhookSignature(req.body, signature)) {
    logger.error('POST /payments/webhook: invalid signature — rejecting');
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid webhook signature' } });
  }

  let event;
  try {
    event = JSON.parse(req.body.toString('utf8'));
  } catch {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Malformed webhook payload' } });
  }

  const reference = event?.data?.reference;
  if (!reference || !['charge.success', 'charge.failed'].includes(event.event)) {
    // A real, signed Paystack event, just not one this endpoint acts on
    // (subscriptions, transfers, etc.) — acknowledge and move on.
    return res.sendStatus(200);
  }

  try {
    const transaction = await paymentModel.findTransactionByReference(reference);
    if (!transaction) {
      logger.error(`POST /payments/webhook: no transaction for reference ${reference}`);
      return res.sendStatus(200);
    }

    const resolvedStatus = event.event === 'charge.success' && event.data.status === 'success' ? 'success' : 'failed';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      // A bill-level transaction (whole-bill or per-share — see
      // billController.js) has bill_id set instead of order_id; branch
      // to its own resolution path rather than trying to force both
      // shapes through markTransactionResolved, which assumes exactly
      // one order.
      if (transaction.bill_id) {
        await billModel.resolveBillTransaction(
          { transactionId: transaction.id, billId: transaction.bill_id, reference, status: resolvedStatus, gatewayResponse: event.data },
          client
        );
      } else {
        await paymentModel.markTransactionResolved(
          { transactionId: transaction.id, orderId: transaction.order_id, status: resolvedStatus, gatewayResponse: event.data },
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

    res.sendStatus(200);
  } catch (err) {
    logger.error(`POST /payments/webhook: failed to process event: ${err.message}`);
    // 500 here is correct (not a swallowed 200) — Paystack will retry,
    // and this really did fail to persist.
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to process webhook' } });
  }
}
