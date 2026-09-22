import crypto from 'node:crypto';
import { z } from 'zod';

import * as guestVerificationModel from '../models/guestVerificationModel.js';
import { hashOpaqueToken } from '../auth.js';
import { sendSms } from '../notifications.js';
import { logger } from '../logger.js';

const OTP_EXPIRY_MINUTES = 10;
const MAX_ATTEMPTS = 5;

export const requestOtpSchema = z.object({
  phone_number: z.string().min(1, 'required'),
});

export const confirmOtpSchema = z.object({
  phone_number: z.string().min(1, 'required'),
  code: z.string().length(6, 'must be a 6-digit code'),
});

function generateCode() {
  // A random integer in [0, 999999], zero-padded — crypto.randomInt is
  // rejection-sampled internally (unlike Math.random()), so this is
  // uniformly distributed, not biased toward smaller numbers.
  return crypto.randomInt(0, 1_000_000).toString().padStart(6, '0');
}

// ---------------------------------------------------------------------
// POST /guest/verify-phone/request — behind authenticateGuest (an
// active, proximity-verified session is required to even ask for a
// code; this isn't reachable by an anonymous script hitting phone
// numbers at random). Not currently required by any other flow — see
// migration 020's doc comment for why enforcement is a separate,
// undecided product question.
// ---------------------------------------------------------------------
export async function requestOtp(req, res) {
  const { phone_number: phoneNumber } = req.body;
  const { restaurant_id: restaurantId } = req.guestSession;

  try {
    const code = generateCode();
    const expiresAt = new Date(Date.now() + OTP_EXPIRY_MINUTES * 60 * 1000);
    await guestVerificationModel.insertOtp(restaurantId, phoneNumber, hashOpaqueToken(code), expiresAt);

    await sendSms({ to: phoneNumber, body: `Your SnapOrder verification code is ${code}. It expires in ${OTP_EXPIRY_MINUTES} minutes.` });

    res.status(200).json({ message: 'A verification code has been sent.' });
  } catch (err) {
    logger.error(`POST /guest/verify-phone/request: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to send verification code' } });
  }
}

// ---------------------------------------------------------------------
// POST /guest/verify-phone/confirm — attempt-limited (MAX_ATTEMPTS)
// against brute-forcing a 6-digit code, on top of the code's own short
// expiry. Exceeding the limit doesn't extend or reset anything — the
// guest has to request a fresh code, which invalidates this one being
// tried (findLatestOpenOtp only ever looks at the newest one).
// ---------------------------------------------------------------------
export async function confirmOtp(req, res) {
  const { phone_number: phoneNumber, code } = req.body;
  const { restaurant_id: restaurantId } = req.guestSession;

  try {
    const otp = await guestVerificationModel.findLatestOpenOtp(restaurantId, phoneNumber);
    if (!otp) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No verification code is pending for this number' } });
    }
    if (otp.attempts >= MAX_ATTEMPTS) {
      return res.status(429).json({ error: { code: 'RATE_LIMITED', message: 'Too many attempts — request a new code' } });
    }
    if (new Date(otp.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'This code has expired — request a new one' } });
    }

    if (hashOpaqueToken(code) !== otp.code_hash) {
      await guestVerificationModel.incrementAttempts(otp.id);
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Incorrect code' } });
    }

    await guestVerificationModel.markVerified(otp.id);
    res.status(200).json({ verified: true });
  } catch (err) {
    logger.error(`POST /guest/verify-phone/confirm: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to verify code' } });
  }
}
