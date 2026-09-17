import crypto from 'node:crypto';

import request from 'supertest';
import { jest } from '@jest/globals';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createTable, createOrder, createGuestSession } from '../helpers/fixtures.js';

// Several tests here deliberately trigger paymentController.js's own
// console.error calls (invalid signature, unknown reference, a Paystack
// rejection) — expected noise from negative-path tests, not failures.
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

describe('POST /v1/orders/:id/payments/initialize', () => {
  it('rejects an order that belongs to a different table', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const otherTable = await createTable(restaurantId, 2);
    const order = await createOrder(restaurantId, table.id, { totalAmount: 3000, tipAmount: 0 });
    const otherGuest = await createGuestSession(restaurantId, otherTable.id, { phoneNumber: '+2348011111111' });

    const res = await request(app)
      .post(`/v1/orders/${order.id}/payments/initialize`)
      .set('Authorization', `Bearer ${otherGuest.token}`);

    expect(res.status).toBe(403);
  });

  it('rejects an already-paid order with 409', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const order = await createOrder(restaurantId, table.id, { totalAmount: 3000, tipAmount: 0 });
    await pool.query(`UPDATE orders SET payment_status = 'completed' WHERE id = $1`, [order.id]);
    const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348011111111' });

    const res = await request(app).post(`/v1/orders/${order.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);

    expect(res.status).toBe(409);
  });

  it('calls Paystack with the grand total (total_amount + tip) in kobo and returns the checkout link', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const order = await createOrder(restaurantId, table.id, { totalAmount: 3000, tipAmount: 200 });
    const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348011111111' });

    const fetchMock = jest.spyOn(global, 'fetch').mockResolvedValue({
      ok: true,
      json: async () => ({
        status: true,
        data: { authorization_url: 'https://checkout.paystack.com/fake', access_code: 'code_1', reference: 'ignored_by_us' },
      }),
    });

    const res = await request(app).post(`/v1/orders/${order.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);

    expect(res.status).toBe(201);
    expect(res.body.authorization_url).toBe('https://checkout.paystack.com/fake');
    expect(Number(res.body.amount)).toBe(3200);

    const [, requestInit] = fetchMock.mock.calls[0];
    const sentBody = JSON.parse(requestInit.body);
    expect(sentBody.amount).toBe(320000); // 3200 NGN in kobo
    expect(sentBody.email).toMatch(/@guest\.snaporder\.app$/);
  });

  it('returns 500 (not a fake success) when Paystack itself rejects the request', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const order = await createOrder(restaurantId, table.id, { totalAmount: 3000, tipAmount: 0 });
    const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348011111111' });

    jest.spyOn(global, 'fetch').mockResolvedValue({ ok: false, status: 401, json: async () => ({ status: false, message: 'Invalid key' }) });

    const res = await request(app).post(`/v1/orders/${order.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);
    expect(res.status).toBe(500);
  });
});

describe('POST /v1/payments/webhook', () => {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;

  function sign(body) {
    return crypto.createHmac('sha512', secret).update(body).digest('hex');
  }

  it('rejects an invalid signature with 401 and does not touch the order', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const order = await createOrder(restaurantId, table.id);
    await pool.query(
      `INSERT INTO payment_transactions (order_id, restaurant_id, reference, amount, status) VALUES ($1, $2, 'ref_bad_sig', 1000, 'pending')`,
      [order.id, restaurantId]
    );

    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ref_bad_sig', status: 'success' } });
    const res = await request(app).post('/v1/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', 'not_a_real_signature').send(body);

    expect(res.status).toBe(401);
    const check = await pool.query('SELECT payment_status FROM orders WHERE id = $1', [order.id]);
    expect(check.rows[0].payment_status).toBe('pending');
  });

  it('marks the order paid on a correctly-signed charge.success event', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const order = await createOrder(restaurantId, table.id);
    await pool.query(
      `INSERT INTO payment_transactions (order_id, restaurant_id, reference, amount, status) VALUES ($1, $2, 'ref_good_sig', 1000, 'pending')`,
      [order.id, restaurantId]
    );

    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'ref_good_sig', status: 'success' } });
    const res = await request(app).post('/v1/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', sign(body)).send(body);

    expect(res.status).toBe(200);
    const order_ = await pool.query('SELECT payment_status, payment_reference FROM orders WHERE id = $1', [order.id]);
    expect(order_.rows[0]).toMatchObject({ payment_status: 'completed', payment_reference: 'ref_good_sig' });

    const txn = await pool.query(`SELECT status, paid_at FROM payment_transactions WHERE reference = 'ref_good_sig'`);
    expect(txn.rows[0].status).toBe('success');
    expect(txn.rows[0].paid_at).not.toBeNull();
  });

  it('acknowledges (200) a correctly-signed event for an unknown reference, without erroring', async () => {
    const body = JSON.stringify({ event: 'charge.success', data: { reference: 'no_such_reference', status: 'success' } });
    const res = await request(app).post('/v1/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', sign(body)).send(body);
    expect(res.status).toBe(200);
  });
});
