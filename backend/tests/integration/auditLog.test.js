import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { generateToken } from '../../src/auth.js';
import { resetDb, closeDb } from '../helpers/db.js';

afterEach(resetDb);
afterAll(closeDb);

// Regression test for a real bug found 2026-09-17: audit_log.restaurant_id
// used to be a hard REFERENCES restaurants(id) ON DELETE CASCADE
// constraint (migration 001). authorize()'s deny() path (middleware/
// authorize.js) logs every denial using whatever :restaurantId is in the
// URL — including one that's a well-formed UUID but doesn't correspond
// to a real restaurant, exactly the shape of a tenant-enumeration probe.
// That write failed the FK check, and audit.js's logAudit() deliberately
// swallows its own errors (so a logging bug never breaks the actual
// request) — so this whole category of denial was invisible everywhere
// except ephemeral console output, never in the durable audit_log table
// SNAPORDER_AUTHORIZATION.md Part 5 requires it to be in. Fixed by
// migration 011 (dropping the FK, keeping the column as a soft
// reference).
describe('audit_log: denials against a nonexistent restaurant id', () => {
  it('are still written, not silently dropped', async () => {
    const user = await pool.query(`INSERT INTO users (email, password_hash) VALUES ('probe@example.com', 'x') RETURNING id`);
    const token = generateToken(user.rows[0].id);
    const fakeRestaurantId = '00000000-0000-0000-0000-000000000000';

    const res = await request(app)
      .get(`/v1/restaurants/${fakeRestaurantId}/analytics/daily`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);

    const logged = await pool.query(
      `SELECT action, actor_type FROM audit_log WHERE restaurant_id = $1 ORDER BY created_at DESC LIMIT 1`,
      [fakeRestaurantId]
    );
    expect(logged.rows[0]).toMatchObject({ action: 'authz_denied', actor_type: 'staff' });
  });
});
