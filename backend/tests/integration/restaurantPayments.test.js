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

function mockPaystack(responses) {
  const spy = jest.spyOn(global, 'fetch');
  responses.forEach((r) => spy.mockImplementationOnce(async () => ({ ok: true, json: async () => r })));
  return spy;
}

async function paidBill(restaurantId, table) {
  const { mealId } = await createMenuWithMeal(restaurantId, { basePrice: 1000 });
  const guest = await createGuestSession(restaurantId, table.id);
  await request(app).post('/v1/orders').set('Authorization', `Bearer ${guest.token}`).send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });
  const bill = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_now' });

  mockPaystack([{ status: true, data: { authorization_url: 'https://checkout.paystack.com/fake', reference: 'ignored' } }]);
  const init = await request(app).post(`/v1/bills/${bill.body.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);

  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  const body = JSON.stringify({ event: 'charge.success', data: { reference: init.body.reference, status: 'success' } });
  const sig = crypto.createHmac('sha512', secret).update(body).digest('hex');
  await request(app).post('/v1/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', sig).send(body);

  return bill.body.id;
}

describe('GET /v1/restaurants/:restaurantId/payments', () => {
  it('rejects a waiter (view_payment_history is manager+)', async () => {
    const restaurantId = await createRestaurant();
    const waiter = await createStaff(restaurantId, 'waiter');
    const res = await request(app).get(`/v1/restaurants/${restaurantId}/payments`).set('Authorization', `Bearer ${waiter.token}`);
    expect(res.status).toBe(403);
  });

  it('lists transactions for a manager', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    await paidBill(restaurantId, table);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/payments`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].status).toBe('success');
  });
});

describe('POST /v1/restaurants/:restaurantId/bills/:billId/refund', () => {
  it('rejects a waiter (issue_refund is manager+)', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const billId = await paidBill(restaurantId, table);
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app).post(`/v1/restaurants/${restaurantId}/bills/${billId}/refund`).set('Authorization', `Bearer ${waiter.token}`);
    expect(res.status).toBe(403);
  });

  it('rejects refunding a bill that was never paid', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const { mealId } = await createMenuWithMeal(restaurantId);
    const guest = await createGuestSession(restaurantId, table.id);
    await request(app).post('/v1/orders').set('Authorization', `Bearer ${guest.token}`).send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });
    const bill = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_now' });
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app).post(`/v1/restaurants/${restaurantId}/bills/${bill.body.id}/refund`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(409);
  });

  it('refunds a paid bill', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const billId = await paidBill(restaurantId, table);
    const manager = await createStaff(restaurantId, 'manager');

    mockPaystack([{ status: true, data: { status: 'processed' } }]);
    const res = await request(app).post(`/v1/restaurants/${restaurantId}/bills/${billId}/refund`).set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('refunded');

    const txn = await pool.query(`SELECT status FROM payment_transactions WHERE bill_id = $1`, [billId]);
    expect(txn.rows[0].status).toBe('refunded');

    const audit = await pool.query(`SELECT action FROM audit_log WHERE action = 'refund_issued' AND resource_id = $1`, [billId]);
    expect(audit.rows).toHaveLength(1);
  });
});
