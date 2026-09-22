import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createTable, createGuestSession } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

async function setUp() {
  const restaurantId = await createRestaurant();
  const table = await createTable(restaurantId, 1);
  const guest = await createGuestSession(restaurantId, table.id);
  return { restaurantId, guest };
}

describe('POST /v1/guest/verify-phone/request', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/v1/guest/verify-phone/request').send({ phone_number: '+2348012345678' });
    expect(res.status).toBe(401);
  });

  it('creates a pending OTP for the phone number', async () => {
    const { guest, restaurantId } = await setUp();

    const res = await request(app)
      .post('/v1/guest/verify-phone/request')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678' });

    expect(res.status).toBe(200);
    const row = await pool.query(
      'SELECT phone_number, verified_at FROM guest_otp_verifications WHERE restaurant_id = $1',
      [restaurantId]
    );
    expect(row.rows).toHaveLength(1);
    expect(row.rows[0].verified_at).toBeNull();
  });
});

describe('POST /v1/guest/verify-phone/confirm', () => {
  it('404s when no code has been requested for that number', async () => {
    const { guest } = await setUp();
    const res = await request(app)
      .post('/v1/guest/verify-phone/confirm')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', code: '123456' });
    expect(res.status).toBe(404);
  });

  it('rejects an incorrect code and increments attempts', async () => {
    const { guest, restaurantId } = await setUp();
    await request(app).post('/v1/guest/verify-phone/request').set('Authorization', `Bearer ${guest.token}`).send({ phone_number: '+2348012345678' });

    const res = await request(app)
      .post('/v1/guest/verify-phone/confirm')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', code: '000000' });

    expect(res.status).toBe(401);
    const row = await pool.query('SELECT attempts FROM guest_otp_verifications WHERE restaurant_id = $1', [restaurantId]);
    expect(row.rows[0].attempts).toBe(1);
  });

  it('locks out after too many wrong attempts', async () => {
    const { guest, restaurantId } = await setUp();
    await request(app).post('/v1/guest/verify-phone/request').set('Authorization', `Bearer ${guest.token}`).send({ phone_number: '+2348012345678' });
    await pool.query('UPDATE guest_otp_verifications SET attempts = 5 WHERE restaurant_id = $1', [restaurantId]);

    const res = await request(app)
      .post('/v1/guest/verify-phone/confirm')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', code: '000000' });

    expect(res.status).toBe(429);
  });

  it('verifies with the correct code — reaching into the DB for the raw code, since it is only ever logged, not returned by the API', async () => {
    const { guest, restaurantId } = await setUp();
    await request(app).post('/v1/guest/verify-phone/request').set('Authorization', `Bearer ${guest.token}`).send({ phone_number: '+2348012345678' });

    // The plaintext code only ever appears in the log line — recompute
    // it via a fresh insert with a KNOWN code so this test doesn't need
    // to intercept logs to know what to send.
    const { hashOpaqueToken } = await import('../../src/auth.js');
    await pool.query(
      `UPDATE guest_otp_verifications SET code_hash = $1 WHERE restaurant_id = $2`,
      [hashOpaqueToken('654321'), restaurantId]
    );

    const res = await request(app)
      .post('/v1/guest/verify-phone/confirm')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', code: '654321' });

    expect(res.status).toBe(200);
    expect(res.body.verified).toBe(true);

    const row = await pool.query('SELECT verified_at FROM guest_otp_verifications WHERE restaurant_id = $1', [restaurantId]);
    expect(row.rows[0].verified_at).not.toBeNull();
  });

  it('rejects an expired code', async () => {
    const { guest, restaurantId } = await setUp();
    const { hashOpaqueToken } = await import('../../src/auth.js');
    await pool.query(
      `INSERT INTO guest_otp_verifications (restaurant_id, phone_number, code_hash, expires_at) VALUES ($1, $2, $3, NOW() - INTERVAL '1 minute')`,
      [restaurantId, '+2348099999999', hashOpaqueToken('111111')]
    );

    const res = await request(app)
      .post('/v1/guest/verify-phone/confirm')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348099999999', code: '111111' });

    expect(res.status).toBe(401);
  });
});
