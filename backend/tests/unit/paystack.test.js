import crypto from 'node:crypto';

import { verifyWebhookSignature } from '../../src/paystack.js';

// PAYSTACK_WEBHOOK_SECRET is set in .env.test (see tests/setupEnv.js).
const SECRET = process.env.PAYSTACK_WEBHOOK_SECRET;

function sign(body) {
  return crypto.createHmac('sha512', SECRET).update(body).digest('hex');
}

describe('paystack.verifyWebhookSignature', () => {
  it('accepts a correctly-signed raw body', () => {
    const body = Buffer.from('{"event":"charge.success","data":{"reference":"ref_1"}}');
    expect(verifyWebhookSignature(body, sign(body))).toBe(true);
  });

  it('rejects a tampered body signed for different content', () => {
    const original = Buffer.from('{"event":"charge.success","data":{"reference":"ref_1"}}');
    const tampered = Buffer.from('{"event":"charge.success","data":{"reference":"ref_2"}}');
    expect(verifyWebhookSignature(tampered, sign(original))).toBe(false);
  });

  it('rejects a signature computed with the wrong secret', () => {
    const body = Buffer.from('{"event":"charge.success"}');
    const wrongSecretSig = crypto.createHmac('sha512', 'not_the_real_secret').update(body).digest('hex');
    expect(verifyWebhookSignature(body, wrongSecretSig)).toBe(false);
  });

  it('rejects a missing signature header', () => {
    const body = Buffer.from('{"event":"charge.success"}');
    expect(verifyWebhookSignature(body, undefined)).toBe(false);
  });
});
