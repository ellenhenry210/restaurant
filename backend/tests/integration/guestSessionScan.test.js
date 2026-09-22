import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createTable } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

// createRestaurant() fixture hardcodes 6.5244/3.3792 (Lagos) as the
// restaurant's location — reused here as "in range".
const IN_RANGE = { latitude: 6.5244, longitude: 3.3792 };

describe('POST /v1/tables/:qrCodeId/scan', () => {
  it('succeeds for a fresh table (no expiry policy configured)', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);

    const res = await request(app).post(`/v1/tables/${table.qr_code_unique_id}/scan`).send(IN_RANGE);

    expect(res.status).toBe(201);
    expect(res.body.session_token).toBeTruthy();
  });

  it('rejects a scan once the QR is older than the restaurant-configured max age', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    await pool.query('UPDATE restaurants SET qr_max_age_days = 30 WHERE id = $1', [restaurantId]);
    await pool.query("UPDATE tables SET qr_rotated_at = NOW() - INTERVAL '31 days' WHERE id = $1", [table.id]);

    const res = await request(app).post(`/v1/tables/${table.qr_code_unique_id}/scan`).send(IN_RANGE);

    expect(res.status).toBe(403);
    expect(res.body.error.message).toMatch(/expired/i);
  });

  it('still succeeds when within the configured max age', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    await pool.query('UPDATE restaurants SET qr_max_age_days = 30 WHERE id = $1', [restaurantId]);
    await pool.query("UPDATE tables SET qr_rotated_at = NOW() - INTERVAL '10 days' WHERE id = $1", [table.id]);

    const res = await request(app).post(`/v1/tables/${table.qr_code_unique_id}/scan`).send(IN_RANGE);

    expect(res.status).toBe(201);
  });
});
