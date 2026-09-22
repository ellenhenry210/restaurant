import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createStaff, createTable } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

describe('GET /v1/qr/:restaurantId/:tableNumber', () => {
  it('rejects an unauthenticated request', async () => {
    const restaurantId = await createRestaurant();
    await createTable(restaurantId, 5);
    const res = await request(app).get(`/v1/qr/${restaurantId}/5`);
    expect(res.status).toBe(401);
  });

  it('rejects a waiter (manage_tables is manager/owner/system_admin only)', async () => {
    const restaurantId = await createRestaurant();
    await createTable(restaurantId, 5);
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app).get(`/v1/qr/${restaurantId}/5`).set('Authorization', `Bearer ${waiter.token}`);
    expect(res.status).toBe(403);
  });

  it('returns a PNG for a manager, encoding the opaque qr_code_unique_id (not the table number)', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 5);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app).get(`/v1/qr/${restaurantId}/5`).set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');
    expect(res.body.length).toBeGreaterThan(0);

    const updated = await pool.query('SELECT qr_code_url FROM tables WHERE id = $1', [table.id]);
    expect(updated.rows[0].qr_code_url).toContain(table.qr_code_unique_id);
    expect(updated.rows[0].qr_code_url).not.toContain('t=5');
  });

  it('404s for a table number that does not exist at this restaurant', async () => {
    const restaurantId = await createRestaurant();
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app).get(`/v1/qr/${restaurantId}/999`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/qr/:restaurantId/:tableNumber/rotate', () => {
  it('rejects a waiter (manage_tables is manager/owner/system_admin only)', async () => {
    const restaurantId = await createRestaurant();
    await createTable(restaurantId, 5);
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app).post(`/v1/qr/${restaurantId}/5/rotate`).set('Authorization', `Bearer ${waiter.token}`);
    expect(res.status).toBe(403);
  });

  it('invalidates the old code and returns a PNG encoding a new one', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 5);
    const manager = await createStaff(restaurantId, 'manager');
    const oldCode = table.qr_code_unique_id;

    const res = await request(app).post(`/v1/qr/${restaurantId}/5/rotate`).set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('image/png');

    const updated = await pool.query('SELECT qr_code_unique_id, qr_code_url FROM tables WHERE id = $1', [table.id]);
    expect(updated.rows[0].qr_code_unique_id).not.toBe(oldCode);
    expect(updated.rows[0].qr_code_url).toContain(updated.rows[0].qr_code_unique_id);

    // The old code no longer resolves to anything at all — this IS the
    // fix for a leaked/photographed QR, not just a cosmetic change.
    const oldScan = await request(app).post(`/v1/tables/${oldCode}/scan`).send({ latitude: 6.5244, longitude: 3.3792 });
    expect(oldScan.status).toBe(404);
  });
});
