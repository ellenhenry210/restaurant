import { verifyToken } from '../auth.js';
import { pool } from '../db.js';
import { logger } from '../logger.js';

/**
 * Express middleware that authenticates a request via a JWT and attaches
 * the corresponding user to req.user — everything downstream (route
 * handlers, the not-yet-built authorize() RBAC/ABAC middleware from
 * SNAPORDER_AUTHORIZATION.md Part 4) can then read req.user instead of
 * re-parsing the token.
 *
 * This is deliberately just authentication ("who are you"), not
 * authorization ("what can you do") — that split matches Part 0 vs.
 * Parts 1-2 of SNAPORDER_AUTHORIZATION.md. This middleware doesn't know
 * or care about roles/restaurants; a route that needs to check a role at
 * a specific restaurant (most of them, once built) does that separately,
 * using req.user.id plus a :restaurantId from the URL to look up the
 * matching restaurant_staff row.
 *
 * ## How this middleware works, step by step
 *
 * 1. Express calls every middleware in the order it was registered, each
 *    one receiving (req, res, next). A middleware either sends a
 *    response itself (ending the chain) or calls next() to hand off to
 *    whatever's registered after it. That's the entire mechanism —
 *    there's no magic beyond "a function that can choose to continue or
 *    stop."
 * 2. We read the `Authorization: Bearer <token>` header. No header (or
 *    the wrong format) means there's nothing to verify — reject
 *    immediately with 401, never calling next().
 * 3. verifyToken() (from auth.js) checks the JWT's signature and expiry.
 *    If it throws, the token is invalid or expired — reject with 401.
 *    We don't leak *why* it's invalid beyond expired-vs-other, since
 *    detailed failure reasons are more useful to an attacker probing the
 *    system than to a legitimate client.
 * 4. Crucially, we do NOT stop at "the token is valid" and trust its
 *    payload. We look the user up fresh from the database by the id the
 *    token names (payload.sub). This is what makes account deletion (or,
 *    once restaurant_staff.is_active-based deprovisioning is checked at
 *    the route/authorize level, a fired employee) actually take effect
 *    immediately, rather than only once their existing token happens to
 *    expire — see SNAPORDER_AUTHORIZATION.md Part 0 for why this
 *    matters.
 * 5. If the lookup succeeds, req.user is set and next() hands off to the
 *    next middleware/route handler, which can now read req.user. If it
 *    fails (row deleted, or a genuine DB error), we reject rather than
 *    letting a request proceed with no user attached.
 */
export async function authenticate(req, res, next) {
  const header = req.headers.authorization;
  const token = header && header.startsWith('Bearer ') ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({
      error: { code: 'UNAUTHORIZED', message: 'Missing or malformed Authorization header' },
    });
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch (err) {
    const message = err.name === 'TokenExpiredError' ? 'Token has expired' : 'Invalid token';
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
  }

  try {
    const result = await pool.query('SELECT id, email, created_at FROM users WHERE id = $1', [payload.sub]);
    const user = result.rows[0];

    if (!user) {
      // The token is validly signed, but the account it names doesn't
      // exist anymore (e.g. deleted after the token was issued) — this
      // is an authorization failure, not a "malformed token" one.
      return res.status(401).json({
        error: { code: 'UNAUTHORIZED', message: 'Account no longer exists' },
      });
    }

    req.user = user;
    next();
  } catch (err) {
    logger.error(`authenticate: user lookup failed: ${err.message}`);
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to authenticate request' },
    });
  }
}
