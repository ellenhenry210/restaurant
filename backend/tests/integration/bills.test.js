import crypto from 'node:crypto';

import request from 'supertest';
import { jest } from '@jest/globals';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createTable, createOrder, createGuestSession, createStaff } from '../helpers/fixtures.js';

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
    json: async () => ({
      status: true,
      data: { authorization_url: 'https://checkout.paystack.com/fake', access_code: 'code_1', reference: 'ignored_by_us' },
    }),
  });
}

async function setUpSittingWithOrders(orderOverrides = [{ subtotal: 2000, tax: 150, serviceCharge: 100, totalAmount: 2250, tipAmount: 0 }]) {
  const restaurantId = await createRestaurant();
  const table = await createTable(restaurantId, 1);
  const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348012345678' });
  const orders = [];
  for (const o of orderOverrides) {
    orders.push(await createOrder(restaurantId, table.id, { sittingId: guest.sittingId, guestProfileId: guest.guestProfileId, ...o }));
  }
  return { restaurantId, table, guest, orders };
}

describe('POST /v1/guest/session/bill', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/v1/guest/session/bill').send({ timing: 'pay_now' });
    expect(res.status).toBe(401);
  });

  it('rejects an invalid timing', async () => {
    const { guest } = await setUpSittingWithOrders();
    const res = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'later' });
    expect(res.status).toBe(400);
  });

  it('rejects when there are no orders to bill yet', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guest = await createGuestSession(restaurantId, table.id);
    const res = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_now' });
    expect(res.status).toBe(400);
  });

  it('creates one whole bill covering every unbilled order in the sitting', async () => {
    const { guest } = await setUpSittingWithOrders([
      { subtotal: 2000, tax: 150, serviceCharge: 100, totalAmount: 2250, tipAmount: 0 },
      { subtotal: 1000, tax: 75, serviceCharge: 50, totalAmount: 1125, tipAmount: 100 },
    ]);

    const res = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_now' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('open');
    expect(Number(res.body.total_amount)).toBe(3375); // 2250 + 1125
    expect(Number(res.body.tip_amount)).toBe(100);

    const orders = await pool.query('SELECT bill_id FROM orders WHERE sitting_id = $1', [guest.sittingId]);
    expect(orders.rows.every((o) => o.bill_id === res.body.id)).toBe(true);
  });

  it('is idempotent — a second call for the same sitting returns the existing bill', async () => {
    const { guest } = await setUpSittingWithOrders();
    const first = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_now' });
    const second = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_now' });

    expect(second.status).toBe(200);
    expect(second.body.id).toBe(first.body.id);
  });

  it('pay_traditional creates a staff call and sets the bill to awaiting_payment', async () => {
    const { guest, restaurantId, table } = await setUpSittingWithOrders();

    const res = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_traditional' });

    expect(res.status).toBe(201);
    expect(res.body.status).toBe('awaiting_payment');

    const calls = await pool.query('SELECT * FROM staff_calls WHERE restaurant_id = $1 AND table_id = $2', [restaurantId, table.id]);
    expect(calls.rows).toHaveLength(1);
    expect(calls.rows[0]).toMatchObject({ reason: 'payment', status: 'pending', bill_id: res.body.id });
  });
});

describe('GET /v1/guest/session/bill/:billId', () => {
  it('rejects a bill that does not belong to the caller\'s table', async () => {
    const { guest: guestA } = await setUpSittingWithOrders();
    const { guest: guestB } = await setUpSittingWithOrders();

    const created = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guestA.token}`).send({ timing: 'pay_now' });
    const res = await request(app).get(`/v1/guest/session/bill/${created.body.id}`).set('Authorization', `Bearer ${guestB.token}`);

    expect(res.status).toBe(403);
  });
});

describe('POST /v1/bills/:billId/request-split', () => {
  async function createBill(timing = 'pay_now', orderOverrides) {
    const ctx = await setUpSittingWithOrders(orderOverrides);
    const created = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${ctx.guest.token}`).send({ timing });
    return { ...ctx, bill: created.body };
  }

  it('even split divides the total across num_parties, remainder to the first share', async () => {
    const { guest, bill } = await createBill('pay_now', [{ subtotal: 1000, tax: 0, serviceCharge: 0, totalAmount: 1000, tipAmount: 0 }]);

    const res = await request(app)
      .post(`/v1/bills/${bill.id}/request-split`)
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ split_type: 'even', num_parties: 3 });

    expect(res.status).toBe(201);
    expect(res.body.shares).toHaveLength(3);
    const amounts = res.body.shares.map((s) => Number(s.amount_owed)).sort((a, b) => a - b);
    expect(amounts).toEqual([333.33, 333.33, 333.34]);

    const updatedBill = await request(app).get(`/v1/guest/session/bill/${bill.id}`).set('Authorization', `Bearer ${guest.token}`);
    expect(updatedBill.body.status).toBe('split_requested');
  });

  it('custom split requires shares summing exactly to the bill total', async () => {
    const { guest, bill } = await createBill();

    const bad = await request(app)
      .post(`/v1/bills/${bill.id}/request-split`)
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ split_type: 'custom', num_parties: 2, shares: [{ guest_label: 'A', amount_owed: 1000 }, { guest_label: 'B', amount_owed: 1000 }] });
    expect(bad.status).toBe(400);

    const good = await request(app)
      .post(`/v1/bills/${bill.id}/request-split`)
      .set('Authorization', `Bearer ${guest.token}`)
      .send({
        split_type: 'custom',
        num_parties: 2,
        shares: [
          { guest_label: 'A', amount_owed: 1000 },
          { guest_label: 'B', amount_owed: Number(bill.total_amount) - 1000 },
        ],
      });
    expect(good.status).toBe(201);
  });

  it('rejects a second split request for the same bill', async () => {
    const { guest, bill } = await createBill();
    await request(app).post(`/v1/bills/${bill.id}/request-split`).set('Authorization', `Bearer ${guest.token}`).send({ split_type: 'even', num_parties: 2 });

    const res = await request(app)
      .post(`/v1/bills/${bill.id}/request-split`)
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ split_type: 'even', num_parties: 2 });

    expect(res.status).toBe(409);
  });
});

describe('POST /v1/bills/:billId/payments/initialize', () => {
  async function createBill(timing = 'pay_now', orderOverrides) {
    const ctx = await setUpSittingWithOrders(orderOverrides);
    const created = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${ctx.guest.token}`).send({ timing });
    return { ...ctx, bill: created.body };
  }

  it('rejects a pay_traditional bill with 400', async () => {
    const { guest, bill } = await createBill('pay_traditional');
    const res = await request(app).post(`/v1/bills/${bill.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);
    expect(res.status).toBe(400);
  });

  it('rejects once a split has been requested, with 409', async () => {
    const { guest, bill } = await createBill();
    await request(app).post(`/v1/bills/${bill.id}/request-split`).set('Authorization', `Bearer ${guest.token}`).send({ split_type: 'even', num_parties: 2 });

    mockPaystackSuccess();
    const res = await request(app).post(`/v1/bills/${bill.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);
    expect(res.status).toBe(409);
  });

  it('calls Paystack with the grand total in kobo and marks the bill awaiting_payment', async () => {
    const { guest, bill } = await createBill('pay_now', [{ subtotal: 1000, tax: 0, serviceCharge: 0, totalAmount: 1000, tipAmount: 200 }]);
    const fetchMock = mockPaystackSuccess();

    const res = await request(app).post(`/v1/bills/${bill.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);

    expect(res.status).toBe(201);
    expect(Number(res.body.amount)).toBe(1200); // total + tip
    const [, requestInit] = fetchMock.mock.calls[0];
    expect(JSON.parse(requestInit.body).amount).toBe(120000);

    const updated = await pool.query('SELECT status FROM bills WHERE id = $1', [bill.id]);
    expect(updated.rows[0].status).toBe('awaiting_payment');
  });
});

describe('bill payment webhook cascade', () => {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  function sign(body) {
    return crypto.createHmac('sha512', secret).update(body).digest('hex');
  }

  it('marks a whole bill paid on a correctly-signed charge.success event', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348012345678' });
    await createOrder(restaurantId, table.id, { sittingId: guest.sittingId, guestProfileId: guest.guestProfileId, totalAmount: 1000 });

    const created = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_now' });
    mockPaystackSuccess();
    const init = await request(app).post(`/v1/bills/${created.body.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);

    const body = JSON.stringify({ event: 'charge.success', data: { reference: init.body.reference, status: 'success' } });
    const res = await request(app).post('/v1/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', sign(body)).send(body);

    expect(res.status).toBe(200);
    const bill = await pool.query('SELECT status, settled_at FROM bills WHERE id = $1', [created.body.id]);
    expect(bill.rows[0].status).toBe('paid');
    expect(bill.rows[0].settled_at).not.toBeNull();
  });

  it('cascades the bill to paid only once every split share is paid', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348012345678' });
    await createOrder(restaurantId, table.id, { sittingId: guest.sittingId, guestProfileId: guest.guestProfileId, subtotal: 1000, tax: 0, serviceCharge: 0, totalAmount: 1000, tipAmount: 0 });

    const created = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_now' });
    const split = await request(app)
      .post(`/v1/bills/${created.body.id}/request-split`)
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ split_type: 'even', num_parties: 2 });
    const [shareA, shareB] = split.body.shares;

    mockPaystackSuccess();
    const payA = await request(app).post(`/v1/bills/splits/${shareA.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);
    const payB = await request(app).post(`/v1/bills/splits/${shareB.id}/payments/initialize`).set('Authorization', `Bearer ${guest.token}`);

    const signAndSend = async (reference) => {
      const body = JSON.stringify({ event: 'charge.success', data: { reference, status: 'success' } });
      return request(app).post('/v1/payments/webhook').set('Content-Type', 'application/json').set('x-paystack-signature', sign(body)).send(body);
    };

    await signAndSend(payA.body.reference);
    let bill = await pool.query('SELECT status FROM bills WHERE id = $1', [created.body.id]);
    expect(bill.rows[0].status).toBe('split_requested'); // only one of two shares paid so far

    await signAndSend(payB.body.reference);
    bill = await pool.query('SELECT status FROM bills WHERE id = $1', [created.body.id]);
    expect(bill.rows[0].status).toBe('paid');

    const shares = await pool.query('SELECT payment_status FROM bill_split_shares WHERE split_id = $1', [split.body.id]);
    expect(shares.rows.every((s) => s.payment_status === 'paid')).toBe(true);
  });
});

describe('staff calls', () => {
  it('rejects a role without process_payment', async () => {
    const restaurantId = await createRestaurant();
    const staff = await createStaff(restaurantId, 'kitchen_staff');
    const res = await request(app).get(`/v1/restaurants/${restaurantId}/staff-calls`).set('Authorization', `Bearer ${staff.token}`);
    expect(res.status).toBe(403);
  });

  it('resolving a call for a pay_traditional bill settles the bill', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348012345678' });
    await createOrder(restaurantId, table.id, { sittingId: guest.sittingId, guestProfileId: guest.guestProfileId, totalAmount: 1000 });
    const created = await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_traditional' });

    const staff = await createStaff(restaurantId, 'waiter');
    const list = await request(app).get(`/v1/restaurants/${restaurantId}/staff-calls?status=pending`).set('Authorization', `Bearer ${staff.token}`);
    expect(list.body.data).toHaveLength(1);
    const callId = list.body.data[0].id;

    const ack = await request(app).patch(`/v1/restaurants/${restaurantId}/staff-calls/${callId}`).set('Authorization', `Bearer ${staff.token}`).send({ status: 'acknowledged' });
    expect(ack.status).toBe(200);

    const resolve = await request(app).patch(`/v1/restaurants/${restaurantId}/staff-calls/${callId}`).set('Authorization', `Bearer ${staff.token}`).send({ status: 'resolved' });
    expect(resolve.status).toBe(200);

    const bill = await pool.query('SELECT status FROM bills WHERE id = $1', [created.body.id]);
    expect(bill.rows[0].status).toBe('settled_traditionally');
  });

  it('rejects an invalid transition (pending -> pending) with 409, not a validation error', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348012345678' });
    await createOrder(restaurantId, table.id, { sittingId: guest.sittingId, guestProfileId: guest.guestProfileId, totalAmount: 1000 });
    await request(app).post('/v1/guest/session/bill').set('Authorization', `Bearer ${guest.token}`).send({ timing: 'pay_traditional' });

    const staff = await createStaff(restaurantId, 'waiter');
    const list = await request(app).get(`/v1/restaurants/${restaurantId}/staff-calls`).set('Authorization', `Bearer ${staff.token}`);
    const callId = list.body.data[0].id;

    const res = await request(app).patch(`/v1/restaurants/${restaurantId}/staff-calls/${callId}`).set('Authorization', `Bearer ${staff.token}`).send({ status: 'pending' });
    expect(res.status).toBe(409);
  });
});
