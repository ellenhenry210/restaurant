import crypto from 'node:crypto';

// Direct REST calls via Node's built-in fetch — not the `paystack` or
// `paystack-js` npm packages, both of which were removed from this
// project (critical vulnerabilities, npm audit). Paystack's API is a
// handful of plain HTTP calls; a dependency isn't worth carrying for
// that, and this is exactly the plan already recorded before this was
// built.
const PAYSTACK_BASE_URL = 'https://api.paystack.co';

function getSecretKey() {
  const key = process.env.PAYSTACK_API_KEY;
  if (!key) {
    throw new Error('PAYSTACK_API_KEY is not set');
  }
  return key;
}

/**
 * Start a Paystack transaction and get back a checkout link.
 * @param {object} params
 * @param {string} params.email — Paystack requires one; guests only give
 *   a phone number (see paymentController.js), so callers pass a
 *   synthesized address for guest checkouts.
 * @param {number} params.amountKobo — smallest currency unit (kobo for
 *   NGN), NOT naira — Paystack's `amount` field is always the minor unit.
 * @param {string} params.reference — our own unique reference, so the
 *   webhook can be matched back to a payment_transactions row without
 *   trusting anything Paystack generates.
 * @param {string} [params.callbackUrl]
 * @param {object} [params.metadata]
 * @returns {Promise<{authorization_url: string, access_code: string, reference: string}>}
 */
export async function initializeTransaction({ email, amountKobo, reference, callbackUrl, metadata }) {
  const response = await fetch(`${PAYSTACK_BASE_URL}/transaction/initialize`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      email,
      amount: amountKobo,
      reference,
      callback_url: callbackUrl,
      metadata,
    }),
  });

  const data = await response.json();
  if (!response.ok || data.status !== true) {
    throw new Error(data.message || `Paystack initialize failed (HTTP ${response.status})`);
  }
  return data.data;
}

/**
 * Verify a Paystack webhook actually came from Paystack. MUST be run
 * against the raw request body bytes, not a re-serialized JS object —
 * re-serializing (different key order, spacing) produces a different
 * HMAC and would make every legitimate webhook look forged. See
 * routes/payments.js for how the raw body is preserved.
 * @param {Buffer} rawBody
 * @param {string} signatureHeader — the `x-paystack-signature` header
 */
export function verifyWebhookSignature(rawBody, signatureHeader) {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  if (!secret || !signatureHeader) {
    return false;
  }
  const hash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');
  // timingSafeEqual requires equal-length buffers — a length mismatch
  // means "not equal" outright, not a crash.
  const a = Buffer.from(hash, 'utf8');
  const b = Buffer.from(signatureHeader, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * Refund a previously-successful transaction — issue_refund
 * (manager/owner/system_admin), the write half of the permission that's
 * existed in the matrix since day one with nothing behind it.
 * @param {{ reference: string, amountKobo?: number }} params —
 *   amountKobo omitted refunds the transaction in full; Paystack itself
 *   defaults to a full refund when `amount` isn't sent.
 */
export async function refundTransaction({ reference, amountKobo }) {
  const response = await fetch(`${PAYSTACK_BASE_URL}/refund`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getSecretKey()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ transaction: reference, amount: amountKobo }),
  });

  const data = await response.json();
  if (!response.ok || data.status !== true) {
    throw new Error(data.message || `Paystack refund failed (HTTP ${response.status})`);
  }
  return data.data;
}
