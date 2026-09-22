import request from 'supertest';
import { jest } from '@jest/globals';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createStaff, createTable, createOrder, createMenuWithMeal, createGuestSession } from '../helpers/fixtures.js';

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

  it('includes table_number, not just table_id', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 7);
    await createOrder(restaurantId, table.id);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/orders`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.body.data[0].table_number).toBe(7);
  });
});

describe('GET /v1/restaurants/:restaurantId/orders/:orderId', () => {
  it('returns full order detail with items', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const { mealId } = await createMenuWithMeal(restaurantId);
    const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348012345678' });
    const created = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 2 }] });
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/orders/${created.body.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(1);
    expect(res.body.items[0]).toMatchObject({ quantity: 2 });
    expect(res.body.table_number).toBe(1);
  });

  it('404s for an order at a different restaurant', async () => {
    const restaurantId = await createRestaurant();
    const otherRestaurantId = await createRestaurant();
    const table = await createTable(otherRestaurantId, 1);
    const order = await createOrder(otherRestaurantId, table.id);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/orders/${order.id}`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(404);
  });
});
