import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';

// How long a token stays valid after it's issued. Falls back to 6h if the
// env var isn't set, matching .env.example.
const JWT_EXPIRY = process.env.JWT_EXPIRY || '6h';

// How long a refresh token stays valid — deliberately much longer than
// an access token (that's the whole point of the pair), but still
// bounded rather than forever, so a token that's never explicitly
// revoked doesn't stay usable indefinitely either.
const REFRESH_TOKEN_EXPIRY_DAYS = Number(process.env.REFRESH_TOKEN_EXPIRY_DAYS) || 30;

// How long an MFA challenge (the interstitial step between "password
// checked out" and "TOTP code verified") stays valid — short, since
// it's meant to be used within the same login attempt, not saved for later.
const MFA_CHALLENGE_EXPIRY = '5m';

// Guest sessions get their own, shorter expiry — a typical dining visit,
// not a work shift. Separate from JWT_EXPIRY (staff) so tuning one never
// accidentally changes the other.
const GUEST_SESSION_EXPIRY = process.env.GUEST_SESSION_EXPIRY || '4h';

// Reads the signing secret lazily (called from inside generateToken /
// verifyToken, not at module load time). This matters because of how ESM
// import hoisting works: if this file were imported before dotenv.config()
// runs elsewhere in the app, reading process.env.JWT_SECRET as a top-level
// const would capture `undefined` permanently. Reading it on every call
// instead means it's only ever checked once dotenv has actually had a
// chance to populate process.env.
function getSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    // Fail loudly when a token is actually signed/verified rather than
    // silently using `undefined`, which would make every token
    // forgeable/guessable.
    throw new Error(
      'JWT_SECRET is not set. Add it to your .env file (see .env.example).'
    );
  }
  return secret;
}

/**
 * Create a signed JWT for a given user.
 *
 * @param {string|number} userId - The id of the authenticated user. This is
 *   the only claim we embed by default, keeping the token minimal — extra
 *   user data should be looked up server-side from this id, not trusted
 *   from the token itself.
 * @returns {string} A signed JWT string, e.g. "eyJhbGciOi...".
 */
export function generateToken(userId) {
  if (userId === undefined || userId === null) {
    throw new Error('generateToken requires a userId');
  }

  // `sub` (subject) is the standard JWT claim for "who is this token about".
  // Using it instead of a custom field like `userId` keeps the token
  // compatible with generic JWT tooling and middleware.
  const payload = { sub: userId };

  return jwt.sign(payload, getSecret(), {
    expiresIn: JWT_EXPIRY,
  });
}

/**
 * Create a signed JWT for a guest session — deliberately a distinct
 * function from generateToken(), not an overload of it, so the two
 * identity types (staff vs. guest) can never be confused at a call site.
 * A guest never has a `users` row, so a guest token's `sub` is a
 * guest_sessions.id, not a users.id — `type: 'guest'` in the payload is
 * what lets middleware/authGuest.js (and, just as importantly,
 * middleware/auth.js) tell the two apart and refuse to accept the wrong
 * kind, even though both are structurally just JWTs signed with the same
 * secret. See routes/guestSession.js for how this token is actually
 * issued (gated by proximity to the restaurant, not on request alone).
 *
 * @param {string} guestSessionId - id of the guest_sessions row this
 *   token represents.
 * @param {{ tableId: string, restaurantId: string }} claims - embedded so
 *   downstream checks don't need a DB round-trip just to know which
 *   table/restaurant a guest session belongs to. Unlike staff tokens,
 *   this is intentionally NOT minimal — see the design note in
 *   middleware/authGuest.js for why that's fine here even though
 *   auth.js's own doc comment on generateToken() argues against it for
 *   staff (a guest session's table/restaurant can't change mid-session
 *   the way a staff member's role can).
 * @returns {string} A signed JWT string.
 */
export function generateGuestToken(guestSessionId, { tableId, restaurantId }) {
  if (!guestSessionId || !tableId || !restaurantId) {
    throw new Error('generateGuestToken requires guestSessionId, tableId, and restaurantId');
  }

  const payload = { sub: guestSessionId, type: 'guest', tableId, restaurantId };

  return jwt.sign(payload, getSecret(), {
    expiresIn: GUEST_SESSION_EXPIRY,
  });
}

/**
 * Verify a JWT's signature and expiry, and return its decoded payload.
 *
 * jwt.verify() does two things in one call: it recomputes the signature
 * over the header+payload using JWT_SECRET and checks it matches (proving
 * the token wasn't forged or tampered with), and it checks the `exp` claim
 * against the current time (proving the token hasn't expired).
 *
 * @param {string} token - The JWT to verify, as received from a client
 *   (typically the `Authorization: Bearer <token>` header).
 * @returns {{ sub: string|number, iat: number, exp: number }} The decoded
 *   payload if the token is valid.
 * @throws {jwt.JsonWebTokenError} If the signature is invalid or the token
 *   is malformed.
 * @throws {jwt.TokenExpiredError} If the token's expiry has passed.
 */
export function verifyToken(token) {
  if (!token) {
    throw new Error('verifyToken requires a token');
  }

  // Throws (rather than returning null/false) on any invalid, tampered, or
  // expired token — callers should catch this and respond 401, not treat
  // a caught error as "valid".
  return jwt.verify(token, getSecret());
}

/**
 * A new opaque refresh token — a random value, not a JWT. Deliberately
 * not self-describing (no embedded expiry/claims a client could decode)
 * since the whole point is that its validity is decided server-side, by
 * looking up its hash in `refresh_tokens` (routes/auth.js), the same way
 * a session cookie would be — that's what makes early revocation
 * (logout, a detected compromise) actually take effect.
 * @returns {{ raw: string, hash: string, expiresAt: Date }}
 */
export function generateRefreshToken() {
  const raw = crypto.randomBytes(40).toString('hex');
  const hash = hashOpaqueToken(raw);
  const expiresAt = new Date(Date.now() + REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000);
  return { raw, hash, expiresAt };
}

/**
 * SHA-256 hex digest — used for both refresh tokens and password-reset
 * tokens (routes/auth.js). Not bcrypt: these are already high-entropy
 * random values (unlike a human-chosen password), so there's no
 * brute-forcing risk a slow hash defends against; a fast, deterministic
 * hash is what lets a lookup query find the row by hash directly instead
 * of re-hashing and comparing every stored row.
 * @param {string} raw
 * @returns {string}
 */
export function hashOpaqueToken(raw) {
  return crypto.createHash('sha256').update(raw).digest('hex');
}

/**
 * A short-lived, single-purpose token proving "this user's password
 * just checked out, but they still need to provide a TOTP code" — the
 * interstitial step in routes/auth.js's login flow when mfa_enabled is
 * true. Deliberately its own token `type` (mirroring generateGuestToken's
 * reasoning) so it can never be mistaken for, or accepted in place of, a
 * real access token by any authenticate()-guarded route.
 * @param {string} userId
 * @returns {string}
 */
export function generateMfaChallengeToken(userId) {
  return jwt.sign({ sub: userId, type: 'mfa_challenge' }, getSecret(), { expiresIn: MFA_CHALLENGE_EXPIRY });
}
