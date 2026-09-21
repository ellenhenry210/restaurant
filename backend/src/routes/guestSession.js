import { Router } from 'express';
import crypto from 'node:crypto';

import { pool } from '../db.js';
import { generateGuestToken } from '../auth.js';
import { authenticateGuest } from '../middleware/authGuest.js';
import { distanceMeters } from '../geo.js';
import * as billModel from '../models/billModel.js';

const router = Router();

function validateScanInput(body) {
  const errors = [];
  if (typeof body.latitude !== 'number' || Number.isNaN(body.latitude) || body.latitude < -90 || body.latitude > 90) {
    errors.push({ field: 'latitude', reason: 'must be a number between -90 and 90' });
  }
  if (typeof body.longitude !== 'number' || Number.isNaN(body.longitude) || body.longitude < -180 || body.longitude > 180) {
    errors.push({ field: 'longitude', reason: 'must be a number between -180 and 180' });
  }
  return errors;
}

// ---------------------------------------------------------------------
// POST /tables/:qrCodeId/scan — the entry point of the entire guest
// experience: scanning the physical QR code on a table. Deliberately not
// behind authenticate()/authorize() — there's no identity yet at this
// point, that's exactly what this route creates. The gate here is
// proximity, not a role.
// ---------------------------------------------------------------------
router.post('/tables/:qrCodeId/scan', async (req, res) => {
  const errors = validateScanInput(req.body ?? {});
  if (errors.length > 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'One or more fields are invalid', details: errors },
    });
  }

  const { latitude, longitude } = req.body;
  const { qrCodeId } = req.params;

  try {
    const tableResult = await pool.query(
      `SELECT t.id AS table_id, t.restaurant_id, t.is_active AS table_active,
              r.name AS restaurant_name, r.latitude AS restaurant_lat,
              r.longitude AS restaurant_lon, r.max_guest_distance_meters
       FROM tables t
       JOIN restaurants r ON r.id = t.restaurant_id
       WHERE t.qr_code_unique_id = $1`,
      [qrCodeId]
    );
    const table = tableResult.rows[0];

    if (!table) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Table not found' } });
    }
    if (!table.table_active) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This table is not currently active' } });
    }

    // Fail closed: a restaurant that hasn't set its location yet can't
    // be proximity-checked at all, so guest ordering can't be safely
    // allowed there — this is a restaurant setup gap to fix (set
    // latitude/longitude), not something a guest can do anything about.
    if (table.restaurant_lat === null || table.restaurant_lon === null) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: 'This restaurant has not configured its location yet — guest ordering is unavailable until it does',
        },
      });
    }

    const distance = distanceMeters(
      { latitude, longitude },
      { latitude: Number(table.restaurant_lat), longitude: Number(table.restaurant_lon) }
    );

    if (distance > table.max_guest_distance_meters) {
      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `You need to be at ${table.restaurant_name} to order here — you appear to be about ${Math.round(distance)}m away (max ${table.max_guest_distance_meters}m).`,
        },
      });
    }

    // Within range. Join the table's currently open sitting (another
    // guest at the same table, same visit) or open a fresh one — this is
    // the "a new group has sat down" signal (SNAPORDER_DATABASE_SCHEMA.md's
    // "Payment & Billing Model" section): the natural, already-existing
    // trigger point, no separate guest action needed.
    let sitting = await billModel.findOpenSittingByTable(table.table_id);
    if (!sitting) {
      sitting = await billModel.createSitting(table.restaurant_id, table.table_id);
    }

    // Generate the session id ourselves (rather than letting Postgres's
    // gen_random_uuid() default assign one) so we have it before the row
    // exists, to embed in the token — then decode the token's own exp
    // back out, so guest_sessions.expires_at and the JWT's expiry can
    // never drift apart by re-deriving the same "4h" duration two
    // different ways.
    const sessionId = crypto.randomUUID();
    const token = generateGuestToken(sessionId, {
      tableId: table.table_id,
      restaurantId: table.restaurant_id,
    });
    const { exp } = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf-8'));
    const expiresAt = new Date(exp * 1000);

    await pool.query(
      `INSERT INTO guest_sessions (id, table_id, restaurant_id, sitting_id, scan_latitude, scan_longitude, distance_meters, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [sessionId, table.table_id, table.restaurant_id, sitting.id, latitude, longitude, distance, expiresAt]
    );

    res.status(201).json({
      session_token: token,
      expires_at: expiresAt.toISOString(),
      restaurant: { id: table.restaurant_id, name: table.restaurant_name },
      distance_meters: Math.round(distance * 10) / 10,
    });
  } catch (err) {
    console.error('POST /tables/:qrCodeId/scan: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to start guest session' } });
  }
});

// ---------------------------------------------------------------------
// POST /guest/session/heartbeat — periodic re-proof of location for an
// already-issued session. The scan endpoint above only ever checked
// distance once, at issuance; without this, a guest who scanned while
// present and then left kept full access for the rest of the token's
// 4-hour life. The frontend calls this on an interval for as long as a
// session is active (see RequireGuestSession.jsx) and drops the session
// the moment this returns 403.
//
// Deliberately does NOT extend expires_at — this only re-verifies an
// existing session's location, it isn't a renewal mechanism.
// ---------------------------------------------------------------------
router.post('/guest/session/heartbeat', authenticateGuest, async (req, res) => {
  const errors = validateScanInput(req.body ?? {});
  if (errors.length > 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'One or more fields are invalid', details: errors },
    });
  }

  const { latitude, longitude } = req.body;

  try {
    const restaurantResult = await pool.query(
      `SELECT name, latitude AS restaurant_lat, longitude AS restaurant_lon, max_guest_distance_meters
       FROM restaurants WHERE id = $1`,
      [req.guestSession.restaurant_id]
    );
    const restaurant = restaurantResult.rows[0];

    // The original scan already required a configured location to reach
    // this point at all, but a restaurant could theoretically clear its
    // coordinates afterwards — fail closed the same way scan does rather
    // than assume this can't happen.
    if (!restaurant || restaurant.restaurant_lat === null || restaurant.restaurant_lon === null) {
      return res.status(403).json({
        error: { code: 'FORBIDDEN', message: 'This restaurant has not configured its location — your session cannot be re-verified' },
      });
    }

    const distance = distanceMeters(
      { latitude, longitude },
      { latitude: Number(restaurant.restaurant_lat), longitude: Number(restaurant.restaurant_lon) }
    );

    await pool.query(
      `UPDATE guest_sessions SET last_checked_at = NOW(), last_latitude = $2, last_longitude = $3, last_distance_meters = $4 WHERE id = $1`,
      [req.guestSession.id, latitude, longitude, distance]
    );

    if (distance > restaurant.max_guest_distance_meters) {
      // Revoke immediately, the same way an operator-initiated revocation
      // works (authGuest.js's expires_at check) — set it into the past
      // rather than deleting the row, so it stays in place as an audit
      // trail of exactly when/why this session ended.
      await pool.query(`UPDATE guest_sessions SET expires_at = NOW() WHERE id = $1`, [req.guestSession.id]);
      await pool.query(
        `INSERT INTO audit_log (restaurant_id, action, actor_type, actor_id, resource_type, resource_id, changes)
         VALUES ($1, 'guest_session_revoked', 'guest', $2, 'guest_session', $2, $3)`,
        [
          req.guestSession.restaurant_id,
          req.guestSession.id,
          JSON.stringify({ reason: 'out_of_range', distance_meters: Math.round(distance * 10) / 10, max_allowed: restaurant.max_guest_distance_meters }),
        ]
      );

      return res.status(403).json({
        error: {
          code: 'FORBIDDEN',
          message: `You've moved out of range of ${restaurant.name} — please scan the table's QR code again to continue.`,
        },
      });
    }

    res.json({ ok: true, distance_meters: Math.round(distance * 10) / 10 });
  } catch (err) {
    console.error('POST /guest/session/heartbeat: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to verify session' } });
  }
});

// ---------------------------------------------------------------------
// GET /guest/session — "who is this guest session" (the authenticateGuest
// counterpart to GET /v1/me), and the working proof that it functions:
// no session, expired session, or a staff token all get rejected; a
// live one from the scan above succeeds.
// ---------------------------------------------------------------------
router.get('/guest/session', authenticateGuest, async (req, res) => {
  try {
    const [sessionResult, staffResult] = await Promise.all([
      pool.query(
        `SELECT r.name AS restaurant_name, t.table_number
         FROM guest_sessions gs
         JOIN restaurants r ON r.id = gs.restaurant_id
         JOIN tables t ON t.id = gs.table_id
         WHERE gs.id = $1`,
        [req.guestSession.id]
      ),
      // Who's currently serving this table — "the guest should know the
      // staff that is assigned to serving them" (explicit user request).
      // display_name (customizable, guest-facing) is preferred over the
      // required legal `name` when set.
      pool.query(
        `SELECT rs.name, rs.display_name, rs.role
         FROM table_assignments ta
         JOIN restaurant_staff rs ON rs.id = ta.staff_id
         WHERE ta.table_id = $1 AND ta.unassigned_at IS NULL`,
        [req.guestSession.table_id]
      ),
    ]);

    const staff = staffResult.rows[0];
    res.json({
      session: req.guestSession,
      ...sessionResult.rows[0],
      server: staff ? { name: staff.display_name ?? staff.name, role: staff.role } : null,
    });
  } catch (err) {
    console.error('GET /guest/session: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load session' } });
  }
});

export default router;
