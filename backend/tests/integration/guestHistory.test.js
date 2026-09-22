import crypto from 'node:crypto';

import request from 'supertest';
import { jest } from '@jest/globals';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createTable, createMenuWithMeal, createGuestSession, createStaff } from '../helpers/fixtures.js';

let consoleErrorSpy;
beforeAll(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  return resetDb();
});
afterAll(() => {
  consoleErrorSpy.mockRestore();
  return closeDb();
});

function mockPaystackSuccess() {
  return jest.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    json: async () => ({ status: true, data: { authorization_url: 'https://checkout.paystack.com/fake', access_code: 'code_1', reference: 'ignored' } }),
  });
}

async function placeOrder(restaurantId, tableId, guest, mealId) {
  return request(app)
    .post('/v1/orders')
    .set('Authorization', `Bearer ${guest.token}`)
    .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });
}

describe('GET /v1/guest/session/history', () => {
  it('is empty for a session with no orders yet', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guest = await createGuestSession(restaurantId, table.id);

    const res = await request(app).get('/v1/guest/session/history').set('Authorization', `Bearer ${guest.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([]);
  });

  it('lists past orders once a guest_profile is linked', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const { mealId } = await createMenuWithMeal(restaurantId);
    const guest = await createGuestSession(restaurantId, table.id);

    await placeOrder(restaurantId, table.id, guest, mealId);

    const res = await request(app).get('/v1/guest/session/history').set('Authorization', `Bearer ${guest.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });
});

describe('guest_visits wiring', () => {
  it('creates one guest_visits row per sitting on first order, not a second one on a repeat order in the same sitting', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const { mealId } = await createMenuWithMeal(restaurantId);
    const guest = await createGuestSession(restaurantId, table.id);

    await placeOrder(restaurantId, table.id, guest, mealId);
    await placeOrder(restaurantId, table.id, guest, mealId);

    const rows = await pool.query('SELECT sitting_id, guest_profile_id, total_spent FROM guest_visits WHERE restaurant_id = $1', [restaurantId]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].guest_profile_id).not.toBeNull();
    expect(rows.rows[0].total_spent).toBeNull();
  });

  it('fills total_spent once the bill is paid', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const { mealId } = await createMenuWithMeal(restaurantId, { basePrice: 1000 });
    const guest = await createGuestSession(restaurantId, table.id);
    await placeOrder(restaurantId, table.id, guest, mealId);

    const bill = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_now' });
    mockPaystackSuccess();
    const init = await request(app).post(`/v1/bills/${bill.body.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);

    const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
    const body = JSON.stringify({ event: 'charge.success', data: { reference: init.body.reference, status: 'success' } });
    const sig = crypto.createHmac('sha512', secret).update(body).digest('hex');
    await request(app).post('/v1/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(body);

    const row = await pool.query('SELECT total_spent, bill_id FROM guest_visits WHERE restaurant_id = $1', [restaurantId]);
    expect(Number(row.rows[0].total_spent)).toBeGreaterThan(0);
    expect(row.rows[0].bill_id).toBe(bill.body.id);
  });

  it('fills total_spent once a pay_traditional bill is settled by staff', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const { mealId } = await createMenuWithMeal(restaurantId, { basePrice: 1000 });
    const guest = await createGuestSession(restaurantId, table.id);
    await placeOrder(restaurantId, table.id, guest, mealId);

    const bill = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_traditional' });
    const waiter = await createStaff(restaurantId, 'waiter');
    const calls = await request(app).get(`/v1/restaurants/${restaurantId}/staff-calls`).set('Authorization', `Bearer ${waiter.token}`);
    const callId = calls.body.data[0].id;
    await request(app).patch(`/v1/restaurants/${restaurantId}/staff-calls/${callId}`).set('Authorization', `Bearer ${waiter.token}`).send({ status: 'acknowledged' });
    await request(app).patch(`/v1/restaurants/${restaurantId}/staff-calls/${callId}`).set('Authorization', `Bearer ${waiter.token}`).send({ status: 'resolved' });

    const row = await pool.query('SELECT total_spent, bill_id FROM guest_visits WHERE restaurant_id = $1', [restaurantId]);
    expect(Number(row.rows[0].total_spent)).toBeGreaterThan(0);
    expect(row.rows[0].bill_id).toBe(bill.body.id);
  });
});

describe('repeat-guest recognition on GET /v1/guest/session', () => {
  it('is not returning on a first-ever visit, even right after their own order', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const { mealId } = await createMenuWithMeal(restaurantId);
    const guest = await createGuestSession(restaurantId, table.id);
    await placeOrder(restaurantId, table.id, guest, mealId);

    const res = await request(app).get('/v1/guest/session').set('Authorization', `Bearer ${guest.token}`);
    expect(res.body.is_returning_guest).toBe(false);
    expect(res.body.visit_count).toBe(0);
  });

  it('is returning once a PAST sitting exists for the same guest_profile', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const { mealId } = await createMenuWithMeal(restaurantId);

    const firstVisitGuest = await createGuestSession(restaurantId, table.id);
    await placeOrder(restaurantId, table.id, firstVisitGuest, mealId);
    const firstSessionCheck = await request(app).get('/v1/guest/session').set('Authorization', `Bearer ${firstVisitGuest.token}`);
    const guestProfileId = firstSessionCheck.body.session.guest_profile_id;

    // Table turnover — there's no "close sitting" endpoint yet (a known,
    // separately-tracked gap), so simulate it directly the way that
    // mechanism eventually would, to test a genuinely SECOND, later
    // sitting rather than colliding with the still-open first one
    // (unique_open_sitting_per_table would otherwise reject it).
    await pool.query(`UPDATE table_sittings SET status = 'closed' WHERE restaurant_id = $1 AND table_id = $2`, [restaurantId, table.id]);

    // A second, later visit — same guest_profile (same phone), a fresh sitting.
    const secondVisitGuest = await createGuestSession(restaurantId, table.id, { guestProfileId });
    await placeOrder(restaurantId, table.id, secondVisitGuest, mealId);

    const res = await request(app).get('/v1/guest/session').set('Authorization', `Bearer ${secondVisitGuest.token}`);
    expect(res.body.is_returning_guest).toBe(true);
    expect(res.body.visit_count).toBe(1);
  });
});
