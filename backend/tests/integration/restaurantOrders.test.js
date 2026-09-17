import request from 'supertest';
import { jest } from '@jest/globals';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createStaff, createTable, createOrder } from '../helpers/fixtures.js';

// See orders.test.js — same expected, harmless realtime-broadcast noise
// when running the app with no Socket.io server behind it.
let consoleErrorSpy;
beforeAll(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  consoleErrorSpy.mockRestore();
  return closeDb();
});
afterEach(resetDb);

describe('PATCH /v1/restaurants/:restaurantId/orders/:orderId/status', () => {
  it('allows a valid transition (placed -> confirmed) for a waiter', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const order = await createOrder(restaurantId, table.id, { status: 'placed' });
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/orders/${order.id}/status`)
      .set('Authorization', `Bearer ${waiter.token}`)
      .send({ status: 'confirmed' });

    expect(res.status).toBe(200);
    expect(res.body.status).toBe('confirmed');
  });

  it('rejects an illegal transition (placed -> served) with 409', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const order = await createOrder(restaurantId, table.id, { status: 'placed' });
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/orders/${order.id}/status`)
      .set('Authorization', `Bearer ${waiter.token}`)
      .send({ status: 'served' });

    expect(res.status).toBe(409);
  });

  it('rejects kitchen_staff — modify_order does not grant that role', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const order = await createOrder(restaurantId, table.id, { status: 'placed' });
    const kitchenStaff = await createStaff(restaurantId, 'kitchen_staff');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/orders/${order.id}/status`)
      .set('Authorization', `Bearer ${kitchenStaff.token}`)
      .send({ status: 'confirmed' });

    expect(res.status).toBe(403);
  });
});

describe('GET /v1/restaurants/:restaurantId/orders', () => {
  it('is visible to every staff role (view_all_orders)', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    await createOrder(restaurantId, table.id);
    const kitchenStaff = await createStaff(restaurantId, 'kitchen_staff');

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/orders`).set('Authorization', `Bearer ${kitchenStaff.token}`);

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
  });

  it('rejects staff from a different restaurant', async () => {
    const restaurantId = await createRestaurant();
    const otherRestaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    await createOrder(restaurantId, table.id);
    const otherStaff = await createStaff(otherRestaurantId, 'manager');

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/orders`).set('Authorization', `Bearer ${otherStaff.token}`);

    expect(res.status).toBe(403);
  });
});
