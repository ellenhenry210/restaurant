import { Router } from 'express';
import bcrypt from 'bcryptjs';
import crypto from 'node:crypto';
import { z } from 'zod';
import { generateSecret as generateTotpSecret, generateURI as generateTotpUri, verify as verifyTotpCode } from 'otplib';
import QRCode from 'qrcode';

import { pool } from '../db.js';
import { generateToken, generateRefreshToken, generateMfaChallengeToken, hashOpaqueToken, verifyToken } from '../auth.js';
import { authenticate } from '../middleware/auth.js';
import { validate } from '../middleware/validate.js';
import * as authModel from '../models/authModel.js';
import { sendEmail } from '../notifications.js';
import { logger } from '../logger.js';

const router = Router();

const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_SALT_ROUNDS = 12;
const RESET_TOKEN_EXPIRY_MINUTES = 30;
const passwordSchema = z.string().min(MIN_PASSWORD_LENGTH, `must be at least ${MIN_PASSWORD_LENGTH} characters`);

// Standard TOTP parameters — compatible with any authenticator app
// (Google Authenticator, Authy, 1Password, etc.), not a SnapOrder-
// specific choice.
const TOTP_OPTIONS = { algorithm: 'SHA1', digits: 6, period: 30 };

async function checkTotpCode(code, secret) {
  const result = await verifyTotpCode({ token: code, secret, ...TOTP_OPTIONS });
  return result.valid;
}

// ---------------------------------------------------------------------
// Validation — zod schemas, one per endpoint, applied via the validate()
// middleware (replaces the hand-rolled validateXInput functions this
// file used to have — see SNAPORDER_STATUS.md, "no input validation
// library" was a flagged gap).
// ---------------------------------------------------------------------

const registerSchema = z.object({
  restaurant_name: z.string().min(1, 'required'),
  owner_name: z.string().min(1, 'required'),
  email: z.string().min(1, 'required').email('must be a valid email address'),
  password: passwordSchema,
  phone: z.string().optional(),
  address: z.string().optional(),
  registration_number: z.string().optional(),
});

const loginSchema = z.object({
  email: z.string().min(1, 'required'),
  password: z.string().min(1, 'required'),
});

const refreshSchema = z.object({
  refresh_token: z.string().min(1, 'required'),
});

const logoutSchema = z.object({
  refresh_token: z.string().optional(),
});

const forgotPasswordSchema = z.object({
  email: z.string().min(1, 'required'),
});

const resetPasswordSchema = z.object({
  token: z.string().min(1, 'required'),
  password: passwordSchema,
});

const mfaVerifySetupSchema = z.object({
  code: z.string().min(1, 'required'),
});

const mfaVerifyLoginSchema = z.object({
  challenge_token: z.string().min(1, 'required'),
  code: z.string().min(1, 'required'),
});

const mfaDisableSchema = z.object({
  password: z.string().min(1, 'required'),
  code: z.string().min(1, 'required'),
});

// ---------------------------------------------------------------------
// POST /register — onboard a brand-new restaurant, its first (Owner)
// user account, and the users<->restaurant_staff link between them, all
// in one request. This matches the existing documented contract
// ("Register a new restaurant") rather than a generic account-creation
// endpoint — SnapOrder's guests never register (they're identified by
// phone number only; see guest_profiles), so the only thing to register
// is a restaurant and its first staff account.
//
// owner_name is a field this route needs that the original API contract
// doc didn't list (it only had restaurant-level fields) — restaurant_
// staff.name is NOT NULL and there's no sensible default for a person's
// name, so it's a required addition here. SNAPORDER_API_CONTRACTS.md has
// been updated to match.
// ---------------------------------------------------------------------
router.post('/register', validate(registerSchema), async (req, res) => {
  const { restaurant_name, owner_name, email, password, phone, address, registration_number } = req.body;

  let passwordHash;
  try {
    // Async hash, not hashSync: bcrypt is deliberately CPU-expensive (that's
    // what makes it resistant to brute-forcing), and the sync variant would
    // block Node's single event loop thread for that whole time — freezing
    // every other in-flight request on this server for ~100ms+ per hash.
    passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
  } catch (err) {
    logger.error(`register: password hashing failed: ${err.message}`);
    return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to process request' } });
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const restaurantResult = await client.query(
      `INSERT INTO restaurants (name, email, phone, address, registration_number)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, email, created_at`,
      [restaurant_name, email, phone ?? null, address ?? null, registration_number ?? null]
    );
    const restaurant = restaurantResult.rows[0];

    const userResult = await client.query(
      `INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`,
      [email, passwordHash]
    );
    const userId = userResult.rows[0].id;

    await client.query(
      `INSERT INTO restaurant_staff (restaurant_id, user_id, name, role)
       VALUES ($1, $2, $3, 'owner')`,
      [restaurant.id, userId, owner_name]
    );

    await client.query('COMMIT');

    res.status(201).json({
      id: restaurant.id,
      name: restaurant.name,
      email: restaurant.email,
      status: 'active',
      created_at: restaurant.created_at,
    });
  } catch (err) {
    await client.query('ROLLBACK');

    // Postgres unique_violation — either email is already a restaurant's
    // contact email or already a user's login email. Either way, from
    // the caller's perspective it's the same problem: that email is taken.
    if (err.code === '23505') {
      return res.status(409).json({
        error: { code: 'CONFLICT', message: 'An account with this email already exists' },
      });
    }

    logger.error(`register: transaction failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create account' } });
  } finally {
    client.release();
  }
});

/**
 * Issues the real access+refresh token pair and persists the refresh
 * token — the shared final step of both a normal (no MFA) login and a
 * successful mfa/verify-login. Deliberately does the DB write itself
 * (not just token generation) so both call sites can't drift on how a
 * refresh token gets persisted.
 */
async function issueSessionTokens(user, staff) {
  const accessToken = generateToken(user.id);
  const decoded = Buffer.from(accessToken.split('.')[1], 'base64url').toString('utf-8');
  const { iat, exp } = JSON.parse(decoded);

  const refreshToken = generateRefreshToken();
  await authModel.insertRefreshToken(user.id, refreshToken.hash, refreshToken.expiresAt);

  return {
    access_token: accessToken,
    refresh_token: refreshToken.raw,
    expires_in: exp - iat,
    user: {
      id: user.id,
      name: staff.name,
      email: user.email,
      role: staff.role,
      restaurant_id: staff.restaurant_id,
    },
  };
}

/** The active-staff-row lookup login/mfa-verify-login both need — see the comment at its original call site for why "first one found" is a known simplification. */
async function findActiveStaffForUser(userId) {
  const result = await pool.query(
    `SELECT rs.id, rs.restaurant_id, rs.name, rs.role
     FROM restaurant_staff rs
     WHERE rs.user_id = $1 AND rs.is_active = TRUE
     ORDER BY rs.created_at ASC
     LIMIT 1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

// ---------------------------------------------------------------------
// POST /login
// ---------------------------------------------------------------------
router.post('/login', validate(loginSchema), async (req, res) => {
  const { email, password } = req.body;

  // Single generic message for "no such user" AND "wrong password" —
  // distinguishing them in the response would let an attacker enumerate
  // which emails have accounts at all, just by watching which error they
  // get back.
  const invalidCredentials = () =>
    res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid email or password' } });

  try {
    const userResult = await pool.query(
      'SELECT id, email, password_hash, mfa_enabled FROM users WHERE email = $1',
      [email]
    );
    const user = userResult.rows[0];
    if (!user) {
      return invalidCredentials();
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches) {
      return invalidCredentials();
    }

    const staff = await findActiveStaffForUser(user.id);
    if (!staff) {
      // A user with no (active) restaurant role can authenticate as an
      // identity but has nothing to do here — e.g. deactivated everywhere.
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'This account has no active restaurant role' },
      });
    }

    // Password checked out — if MFA is enabled, stop here and hand back
    // a short-lived challenge instead of real tokens. POST /auth/mfa/
    // verify-login is what actually finishes the login, once a valid
    // TOTP code is provided against that challenge.
    if (user.mfa_enabled) {
      return res.status(200).json({
        mfa_required: true,
        challenge_token: generateMfaChallengeToken(user.id),
      });
    }

    const session = await issueSessionTokens(user, staff);
    res.status(200).json(session);
  } catch (err) {
    logger.error(`login: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to process login' } });
  }
});

// ---------------------------------------------------------------------
// POST /refresh — trade a still-valid refresh token for a new access
// token. Rotates the refresh token itself (revokes the one presented,
// issues a fresh one) rather than reusing it indefinitely — standard
// refresh-token-rotation practice, so a refresh token is effectively
// single-use even though it's long-lived.
// ---------------------------------------------------------------------
router.post('/refresh', validate(refreshSchema), async (req, res) => {
  const { refresh_token: rawToken } = req.body;

  const invalid = () => res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired refresh token' } });

  try {
    const tokenRow = await authModel.findRefreshTokenByHash(hashOpaqueToken(rawToken));
    if (!tokenRow || tokenRow.revoked_at || new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      return invalid();
    }

    const userResult = await pool.query('SELECT id, email FROM users WHERE id = $1', [tokenRow.user_id]);
    const user = userResult.rows[0];
    const staff = user ? await findActiveStaffForUser(user.id) : null;
    if (!user || !staff) {
      return invalid();
    }

    await authModel.revokeRefreshToken(tokenRow.id);
    const session = await issueSessionTokens(user, staff);
    res.status(200).json(session);
  } catch (err) {
    logger.error(`refresh: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to refresh session' } });
  }
});

// ---------------------------------------------------------------------
// POST /logout — revokes the given refresh token server-side. Always
// 200s even for a token that's already invalid/unknown: from the
// caller's point of view, "logged out" is the correct outcome either
// way, and this isn't a check worth leaking info through.
// ---------------------------------------------------------------------
router.post('/logout', validate(logoutSchema), async (req, res) => {
  const { refresh_token: rawToken } = req.body;
  if (rawToken && typeof rawToken === 'string') {
    try {
      const tokenRow = await authModel.findRefreshTokenByHash(hashOpaqueToken(rawToken));
      if (tokenRow) {
        await authModel.revokeRefreshToken(tokenRow.id);
      }
    } catch (err) {
      logger.error(`logout: failed to revoke refresh token: ${err.message}`);
    }
  }
  res.status(200).json({ message: 'Logged out' });
});

// ---------------------------------------------------------------------
// POST /forgot-password — always responds 200 with the same generic
// message regardless of whether the email exists, so this can't be used
// to enumerate registered accounts. Delivery is via sendEmail()
// (notifications.js) — plain SMTP, works once SMTP_HOST is configured;
// until then it logs instead of sending (see that file's doc comment).
// Either way, the token itself is generated and stored correctly.
// ---------------------------------------------------------------------
router.post('/forgot-password', validate(forgotPasswordSchema), async (req, res) => {
  const { email } = req.body;

  const genericResponse = () =>
    res.status(200).json({ message: 'If an account exists for that email, a password reset link has been sent.' });

  try {
    const user = await authModel.findUserByEmail(email);
    if (!user) {
      return genericResponse();
    }

    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_EXPIRY_MINUTES * 60 * 1000);

    await authModel.insertPasswordResetToken(user.id, hashOpaqueToken(token), expiresAt);

    const resetUrl = `${process.env.APP_BASE_URL || 'https://snaporder.app'}/reset-password?token=${token}`;
    // Best-effort — sendEmail() never throws, a delivery failure is
    // logged there, not surfaced here (the response stays generic
    // either way, per the doc comment above).
    await sendEmail({
      to: user.email,
      subject: 'Reset your SnapOrder password',
      text: `We received a request to reset your SnapOrder password. This link expires in ${RESET_TOKEN_EXPIRY_MINUTES} minutes:\n\n${resetUrl}\n\nIf you didn't request this, you can ignore this email.`,
    });

    genericResponse();
  } catch (err) {
    logger.error(`forgot-password: failed: ${err.message}`);
    // Still respond with the generic message — an internal error here
    // shouldn't leak "something went wrong specifically for this email"
    // any more than a real failure should.
    genericResponse();
  }
});

// ---------------------------------------------------------------------
// POST /reset-password — consumes a token from /forgot-password.
// Revokes every refresh token the user holds on success, so a stolen
// session can't outlive a password reset meant to shut it down.
// ---------------------------------------------------------------------
router.post('/reset-password', validate(resetPasswordSchema), async (req, res) => {
  const { token, password } = req.body;

  const invalid = () => res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired reset token' } });

  try {
    const tokenRow = await authModel.findPasswordResetTokenByHash(hashOpaqueToken(token));
    if (!tokenRow || tokenRow.used_at || new Date(tokenRow.expires_at).getTime() <= Date.now()) {
      return invalid();
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
    await authModel.updateUserPassword(tokenRow.user_id, passwordHash);
    await authModel.markPasswordResetTokenUsed(tokenRow.id);
    await authModel.revokeAllRefreshTokensForUser(tokenRow.user_id);

    res.status(200).json({ message: 'Password updated — please log in again.' });
  } catch (err) {
    logger.error(`reset-password: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to reset password' } });
  }
});

// ---------------------------------------------------------------------
// MFA — PAM requirement (SNAPORDER_AUTHORIZATION.md Part 7) for Owner/
// System Admin accounts specifically, not a general staff feature.
// TOTP (otplib), compatible with any standard authenticator app.
// ---------------------------------------------------------------------

// POST /mfa/setup — starts setup: generates a new secret (stored as
// "pending" — mfa_enabled stays false until verify-setup succeeds) and
// returns it as both a manual-entry string and a scannable QR (reusing
// the qrcode package already in this project for table QR codes).
router.post('/mfa/setup', authenticate, async (req, res) => {
  try {
    if (!(await authModel.isPrivilegedForMfa(req.user.id))) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'MFA is only available to Owner and System Admin accounts' },
      });
    }

    const user = await authModel.findUserForMfa(req.user.id);
    if (user.mfa_enabled) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'MFA is already enabled on this account' } });
    }

    const secret = generateTotpSecret();
    await authModel.setPendingMfaSecret(req.user.id, secret);

    const otpauthUrl = generateTotpUri({ issuer: 'SnapOrder', label: user.email, secret, type: 'totp', ...TOTP_OPTIONS });
    const qrCodeDataUrl = await QRCode.toDataURL(otpauthUrl);

    res.status(200).json({ secret, otpauth_url: otpauthUrl, qr_code_data_url: qrCodeDataUrl });
  } catch (err) {
    logger.error(`mfa/setup: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to start MFA setup' } });
  }
});

// POST /mfa/verify-setup — proves the user actually has the secret
// (scanned it into a real authenticator app) before MFA is enforced on
// their account.
router.post('/mfa/verify-setup', authenticate, validate(mfaVerifySetupSchema), async (req, res) => {
  const { code } = req.body;

  try {
    const user = await authModel.findUserForMfa(req.user.id);
    if (!user.mfa_secret) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'No MFA setup is in progress — call /mfa/setup first' } });
    }
    if (!(await checkTotpCode(code, user.mfa_secret))) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid code' } });
    }

    await authModel.enableMfa(req.user.id);
    res.status(200).json({ message: 'MFA enabled' });
  } catch (err) {
    logger.error(`mfa/verify-setup: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to verify MFA setup' } });
  }
});

// POST /mfa/verify-login — the second step of a login for an
// mfa_enabled account: exchanges the short-lived challenge_token from
// /login plus a valid TOTP code for the real access/refresh tokens.
router.post('/mfa/verify-login', validate(mfaVerifyLoginSchema), async (req, res) => {
  const { challenge_token: challengeToken, code } = req.body;

  const invalid = () => res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid or expired MFA challenge' } });

  try {
    let payload;
    try {
      payload = verifyToken(challengeToken);
    } catch {
      return invalid();
    }
    if (payload.type !== 'mfa_challenge') {
      return invalid();
    }

    const user = await authModel.findUserForMfa(payload.sub);
    if (!user || !user.mfa_enabled || !(await checkTotpCode(code, user.mfa_secret))) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid code' } });
    }

    const staff = await findActiveStaffForUser(user.id);
    if (!staff) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This account has no active restaurant role' } });
    }

    const session = await issueSessionTokens(user, staff);
    res.status(200).json(session);
  } catch (err) {
    logger.error(`mfa/verify-login: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to verify MFA login' } });
  }
});

// POST /mfa/disable — requires both the current password AND a valid
// TOTP code, not just an authenticated session — disabling MFA is
// exactly the kind of action a stolen access token alone shouldn't be
// able to do.
router.post('/mfa/disable', authenticate, validate(mfaDisableSchema), async (req, res) => {
  const { password, code } = req.body;

  try {
    const user = await authModel.findUserForMfa(req.user.id);
    if (!user.mfa_enabled) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'MFA is not enabled on this account' } });
    }

    const passwordMatches = await bcrypt.compare(password, user.password_hash);
    if (!passwordMatches || !(await checkTotpCode(code, user.mfa_secret))) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Invalid password or code' } });
    }

    await authModel.disableMfa(req.user.id);
    res.status(200).json({ message: 'MFA disabled' });
  } catch (err) {
    logger.error(`mfa/disable: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to disable MFA' } });
  }
});

export default router;
