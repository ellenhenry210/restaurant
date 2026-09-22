import { verifyToken } from '../auth.js';
import { pool } from '../db.js';
import { logger } from '../logger.js';

/**
 * Authenticates a guest session token — the guest-side counterpart to
 * middleware/auth.js's authenticate(), for the same reason that one
 * exists rather than trusting a JWT payload outright: a session can be
 * revoked (e.g. the table_id gets reassigned, or an operator wants to
 * kill a session early) by deleting/expiring the guest_sessions row, and
 * that needs to take effect immediately, not just once the JWT itself
 * expires.
 *
 * Deliberately a SEPARATE function from authenticate(), not a branch
 * inside it, even though both ultimately call verifyToken() on a JWT
 * signed with the same secret: guests and staff are different identity
 * types with no overlap (a guest never has a users row), and keeping the
 * check paths textually separate means a route can only ever be mounted
 * behind the one it actually means to allow — there's no shared code
 * path where a bug could let a guest token satisfy a staff check or vice
 * versa.
 *
 * Design note on what's in the payload: middleware/auth.js's doc comment
 * argues for keeping staff tokens minimal (no role/restaurant_id) so a
 * role change takes effect immediately rather than waiting for token
 * expiry. That reasoning doesn't apply the same way here — a guest
 * session's table_id/restaurant_id don't change mid-session the way a
 * staff member's role can, so embedding them in the token isn't a
 * staleness risk. They're still cross-checked against the guest_sessions
 * row below rather than trusted blindly, since the row is the source of
 * truth for whether the session is still valid at all.
 */
export async function authenticateGuest(req, res, next) {
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
    const message = err.name === 'TokenExpiredError' ? 'Session has expired — please scan again' : 'Invalid session token';
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message } });
  }

  if (payload.type !== 'guest') {
    // A validly-signed token, but not a guest one — e.g. a staff token
    // presented to a guest-only route. Reject rather than trying to
    // partially honor it.
    return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Not a guest session token' } });
  }

  try {
    const result = await pool.query(
      `SELECT id, table_id, restaurant_id, guest_profile_id, sitting_id, expires_at
       FROM guest_sessions
       WHERE id = $1`,
      [payload.sub]
    );
    const session = result.rows[0];

    if (!session) {
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session no longer exists' } });
    }
    if (new Date(session.expires_at).getTime() <= Date.now()) {
      // Belt-and-suspenders beyond the JWT's own exp claim (which
      // verifyToken already checked) — this is the row-level check that
      // would also catch a session explicitly revoked/expired early by
      // setting expires_at into the past, not just natural expiry.
      return res.status(401).json({ error: { code: 'UNAUTHORIZED', message: 'Session has expired — please scan again' } });
    }

    req.guestSession = session;
    next();
  } catch (err) {
    logger.error(`authenticateGuest: session lookup failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to authenticate request' } });
  }
}
