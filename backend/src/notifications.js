import nodemailer from 'nodemailer';

import { logger } from './logger.js';

// Plain SMTP via nodemailer — works with any provider that offers SMTP
// credentials (SendGrid, Postmark, Mailgun, Amazon SES, even a plain
// Gmail account for early testing), rather than locking this to one
// vendor's proprietary API. Closes the delivery half of the password-
// reset gap (routes/auth.js's forgot-password/reset-password already
// had a correct token mechanism — this is the piece that was missing).
//
// No SMTP_HOST configured (the default state — .env.example ships no
// real credentials, same as PAYSTACK_API_KEY's placeholder) means every
// send is a no-op that logs instead of throwing: forgot-password must
// never fail loudly just because delivery isn't configured yet in this
// environment, the same reasoning that keeps that route always
// returning its generic 200.
let transporter;
function getTransporter() {
  if (!process.env.SMTP_HOST) {
    return null;
  }
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT) || 587,
      secure: process.env.SMTP_SECURE === 'true',
      auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined,
    });
  }
  return transporter;
}

// The log-fallback path below necessarily contains the secret itself
// (a reset link/token, an OTP code) — that's the whole point of the
// fallback, so a developer running locally without real credentials can
// still exercise the flow. Found in a security review: logging that
// secret unconditionally meant anyone with read access to logs in ANY
// environment (not just local dev) could complete a reset/verification
// within its validity window without ever touching email or SMS. Gated
// to local development only — everywhere else, the fact that delivery
// didn't happen is logged, not the secret that would have been sent.
const LOG_SECRETS = process.env.NODE_ENV === 'development';

/**
 * Send a plain-text email, or log it if no SMTP provider is configured.
 * Never throws — a notification failing to send is logged, not treated
 * as the caller's own request failing (see forgot-password's use of this).
 * @param {{ to: string, subject: string, text: string }} message
 */
export async function sendEmail({ to, subject, text }) {
  const client = getTransporter();
  if (!client) {
    if (LOG_SECRETS) {
      logger.info(`sendEmail: no SMTP_HOST configured — logging instead of sending. to=${to} subject="${subject}" body="${text}"`);
    } else {
      logger.warn(`sendEmail: no SMTP_HOST configured — message to ${to} ("${subject}") was not sent`);
    }
    return;
  }
  try {
    await client.sendMail({ from: process.env.SMTP_FROM || 'no-reply@snaporder.app', to, subject, text });
  } catch (err) {
    logger.error(`sendEmail: failed to send to ${to}: ${err.message}`);
  }
}

/**
 * SMS delivery for guest phone verification (routes/guestVerification.js).
 * Unlike email, there's no equivalent of "plain SMTP" for SMS — every
 * provider (Termii and Africa's Talking are the common choices for the
 * Nigeria market this project targets; Twilio elsewhere) has its own
 * incompatible API shape (auth scheme, payload format), so a genuinely
 * provider-agnostic implementation isn't possible the way sendEmail's
 * SMTP approach is. This deliberately stays a log-only stub — real
 * delivery needs a specific provider's SDK/API wired in here, not a
 * fake "works with anything" HTTP call that would silently do nothing
 * useful against a real provider's endpoint.
 */
export async function sendSms({ to, body }) {
  if (LOG_SECRETS) {
    logger.info(`sendSms: no SMS provider wired up — logging instead of sending. to=${to} body="${body}"`);
  } else {
    logger.warn(`sendSms: no SMS provider wired up — message to ${to} was not sent`);
  }
}
