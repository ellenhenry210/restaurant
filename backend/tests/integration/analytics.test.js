import request from 'supertest';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createStaff, createTable, createMenuWithMeal, createOrder } from '../helpers/fixtures.js';
import { pool } from '../../src/db.js';

afterEach(resetDb);
afterAll(closeDb);

describe('GET /v1/restaurants/:id/analytics/daily', () => {
  it('rejects a waiter (view_restaurant_analytics is manager/owner/system_admin only)', async () => {
    const restaurantId = await createRestaurant();
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/analytics/daily`).set('Authorization', `Bearer ${waiter.token}`);
    expect(res.status).toBe(403);
  });

  it('allows a manager and computes real metrics from seeded orders', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const { mealId, mealName } = await createMenuWithMeal(restaurantId, { basePrice: 1000 });
    const manager = await createStaff(restaurantId, 'manager');

    const order = await createOrder(restaurantId, table.id, { subtotal: 1000, tax: 0, serviceCharge: 0, totalAmount: 1000, tipAmount: 0 });
    await pool.query(
      `INSERT INTO order_items (order_id, meal_id, meal_name, meal_price, quantity, status) VALUES ($1, $2, $3, $4, $5, 'served')`,
      [order.id, mealId, mealName, 1000, 3]
    );

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/analytics/daily`).set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    expect(res.body.metrics.total_orders).toBe(1);
    expect(res.body.metrics.total_revenue).toBe(1000);
    expect(res.body.metrics.meals_sold).toBe(3);
    expect(res.body.metrics.top_meals[0]).toMatchObject({ meal_id: mealId, quantity_sold: 3 });
  });

  it('excludes cancelled orders from every figure', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const manager = await createStaff(restaurantId, 'manager');
    await createOrder(restaurantId, table.id, { status: 'cancelled', totalAmount: 5000 });

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/analytics/daily`).set('Authorization', `Bearer ${manager.token}`);

    expect(res.body.metrics.total_orders).toBe(0);
    expect(res.body.metrics.total_revenue).toBe(0);
  });

  it('rejects a malformed date', async () => {
    const restaurantId = await createRestaurant();
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/analytics/daily?date=not-a-date`).set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(400);
  });
});
