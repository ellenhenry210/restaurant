import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createTable, createGuestSession } from '../helpers/fixtures.js';

afterAll(closeDb);
afterEach(resetDb);

// createRestaurant() fixture hardcodes 6.5244/3.3792 (Lagos) as the
// restaurant's location, with the default max_guest_distance_meters
// (150m) — reused here as "in range" vs. a point far enough away (a
// different city entirely) to be unambiguously "out of range".
const IN_RANGE = { latitude: 6.5244, longitude: 3.3792 };
const OUT_OF_RANGE = { latitude: 6.4, longitude: 3.9 }; // ~60km away

describe('POST /v1/guest/session/heartbeat', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/v1/guest/session/heartbeat').send(IN_RANGE);
    expect(res.status).toBe(401);
  });

  it('accepts a check-in still within range and records it', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guest = await createGuestSession(restaurantId, table.id);

    const res = await request(app)
      .post('/v1/guest/session/heartbeat')
      .set('Authorization', `Bearer ${guest.token}`)
      .send(IN_RANGE);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const row = await pool.query('SELECT last_checked_at, last_distance_meters FROM guest_sessions WHERE id = $1', [guest.sessionId]);
    expect(row.rows[0].last_checked_at).not.toBeNull();
    expect(Number(row.rows[0].last_distance_meters)).toBeLessThan(150);
  });

  it('revokes the session and logs it when the guest has moved out of range', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guest = await createGuestSession(restaurantId, table.id);

    const res = await request(app)
      .post('/v1/guest/session/heartbeat')
      .set('Authorization', `Bearer ${guest.token}`)
      .send(OUT_OF_RANGE);

    expect(res.status).toBe(403);

    const session = await pool.query('SELECT expires_at FROM guest_sessions WHERE id = $1', [guest.sessionId]);
    expect(new Date(session.rows[0].expires_at).getTime()).toBeLessThanOrEqual(Date.now());

    // The revoked session should be rejected immediately on the very
    // next request, same as any other expired session.
    const followUp = await request(app).get('/v1/guest/session').set('Authorization', `Bearer ${guest.token}`);
    expect(followUp.status).toBe(401);

    const audit = await pool.query(
      `SELECT action, actor_type, resource_id, changes FROM audit_log WHERE resource_id = $1 AND action = 'guest_session_revoked'`,
      [guest.sessionId]
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_type).toBe('guest');
    expect(audit.rows[0].changes.reason).toBe('out_of_range');
  });

  it('rejects invalid coordinates', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guest = await createGuestSession(restaurantId, table.id);

    const res = await request(app)
      .post('/v1/guest/session/heartbeat')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ latitude: 200, longitude: 3.3792 });

    expect(res.status).toBe(400);
  });
});
