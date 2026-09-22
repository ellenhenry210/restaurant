import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createMenuWithMeal, addIngredientToMeal, createStaff } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

describe('PATCH /v1/restaurants/:restaurantId/meals/:mealId/availability', () => {
  it('rejects a waiter (mark_out_of_stock is kitchen_staff+)', async () => {
    const restaurantId = await createRestaurant();
    const { mealId } = await createMenuWithMeal(restaurantId);
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/meals/${mealId}/availability`)
      .set('Authorization', `Bearer ${waiter.token}`)
      .send({ is_available: false });
    expect(res.status).toBe(403);
  });

  it('lets kitchen_staff mark a meal out of stock, and it is audit-logged', async () => {
    const restaurantId = await createRestaurant();
    const { mealId } = await createMenuWithMeal(restaurantId);
    const kitchenStaff = await createStaff(restaurantId, 'kitchen_staff');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/meals/${mealId}/availability`)
      .set('Authorization', `Bearer ${kitchenStaff.token}`)
      .send({ is_available: false });
    expect(res.status).toBe(200);
    expect(res.body.is_available).toBe(false);

    const audit = await pool.query(`SELECT action, resource_id FROM audit_log WHERE action = 'inventory_updated' AND resource_id = $1`, [mealId]);
    expect(audit.rows).toHaveLength(1);
  });
});

describe('ingredients endpoints', () => {
  it('view_inventory is granted to every staff role, including waiter', async () => {
    const restaurantId = await createRestaurant();
    const waiter = await createStaff(restaurantId, 'waiter');
    const res = await request(app).get(`/v1/restaurants/${restaurantId}/ingredients`).set('Authorization', `Bearer ${waiter.token}`);
    expect(res.status).toBe(200);
  });

  it('lists ingredients for kitchen_staff', async () => {
    const restaurantId = await createRestaurant();
    const { mealId } = await createMenuWithMeal(restaurantId);
    await addIngredientToMeal(mealId, restaurantId, { name: 'Tomato' });
    const kitchenStaff = await createStaff(restaurantId, 'kitchen_staff');

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/ingredients`).set('Authorization', `Bearer ${kitchenStaff.token}`);
    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Tomato');
  });

  it('rejects kitchen_staff setting stock levels (set_inventory_levels is manager+)', async () => {
    const restaurantId = await createRestaurant();
    const { mealId } = await createMenuWithMeal(restaurantId);
    const ingredientId = await addIngredientToMeal(mealId, restaurantId);
    const kitchenStaff = await createStaff(restaurantId, 'kitchen_staff');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/ingredients/${ingredientId}/stock`)
      .set('Authorization', `Bearer ${kitchenStaff.token}`)
      .send({ current_stock: 50 });
    expect(res.status).toBe(403);
  });

  it('lets a manager set stock levels', async () => {
    const restaurantId = await createRestaurant();
    const { mealId } = await createMenuWithMeal(restaurantId);
    const ingredientId = await addIngredientToMeal(mealId, restaurantId);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/ingredients/${ingredientId}/stock`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ current_stock: 25, reorder_level: 5 });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ current_stock: 25, reorder_level: 5 });
  });

  it('rejects a body with no fields to update', async () => {
    const restaurantId = await createRestaurant();
    const { mealId } = await createMenuWithMeal(restaurantId);
    const ingredientId = await addIngredientToMeal(mealId, restaurantId);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/ingredients/${ingredientId}/stock`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({});
    expect(res.status).toBe(400);
  });
});
