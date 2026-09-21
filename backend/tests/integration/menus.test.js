import request from 'supertest';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createStaff, createMenuWithMeal } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

describe('GET /v1/meals/:id', () => {
  it('returns the meal with ingredients/addons joined in', async () => {
    const restaurantId = await createRestaurant();
    const { mealId } = await createMenuWithMeal(restaurantId, { name: 'Jollof Rice' });

    const res = await request(app).get(`/v1/meals/${mealId}`);

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Jollof Rice');
    expect(res.body).toHaveProperty('ingredients');
    expect(res.body).toHaveProperty('addons');
  });
});

describe('GET /v1/restaurants/:restaurantId/menus/:menuId/meals', () => {
  it('lists categories with their available meals nested, incl. an empty category', async () => {
    const restaurantId = await createRestaurant();
    const { menuId, categoryId, mealId } = await createMenuWithMeal(restaurantId, { name: 'Jollof Rice', isAvailable: true });

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/menus/${menuId}/meals`);

    expect(res.status).toBe(200);
    expect(res.body.categories).toHaveLength(1);
    expect(res.body.categories[0]).toMatchObject({ id: categoryId });
    expect(res.body.categories[0].meals).toEqual([expect.objectContaining({ id: mealId, name: 'Jollof Rice' })]);
  });

  it('excludes unavailable meals but keeps the category', async () => {
    const restaurantId = await createRestaurant();
    const { menuId, categoryId } = await createMenuWithMeal(restaurantId, { isAvailable: false });

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/menus/${menuId}/meals`);

    expect(res.body.categories).toEqual([expect.objectContaining({ id: categoryId, meals: [] })]);
  });

  it('404s for a menu that does not belong to this restaurant', async () => {
    const restaurantId = await createRestaurant();
    const otherRestaurantId = await createRestaurant();
    const { menuId } = await createMenuWithMeal(otherRestaurantId);

    const res = await request(app).get(`/v1/restaurants/${restaurantId}/menus/${menuId}/meals`);
    expect(res.status).toBe(404);
  });
});

describe('POST /v1/restaurants/:restaurantId/meals', () => {
  it('rejects an unauthenticated request', async () => {
    const restaurantId = await createRestaurant();
    const res = await request(app).post(`/v1/restaurants/${restaurantId}/meals`).send({ name: 'x', base_price: 10 });
    expect(res.status).toBe(401);
  });

  it('rejects a waiter (edit_menu is manager/owner/system_admin only)', async () => {
    const restaurantId = await createRestaurant();
    const { categoryId } = await createMenuWithMeal(restaurantId);
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/meals`)
      .set('Authorization', `Bearer ${waiter.token}`)
      .send({ category_id: categoryId, name: 'Suya', base_price: 1500 });

    expect(res.status).toBe(403);
  });

  it('lets a manager create a meal', async () => {
    const restaurantId = await createRestaurant();
    const { categoryId } = await createMenuWithMeal(restaurantId);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/meals`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ category_id: categoryId, name: 'Suya Skewers', base_price: 1500, is_high_protein: true });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Suya Skewers', is_high_protein: true });
  });

  it('rejects a category_id belonging to a different restaurant', async () => {
    const restaurantId = await createRestaurant();
    const otherRestaurantId = await createRestaurant();
    const { categoryId: otherCategoryId } = await createMenuWithMeal(otherRestaurantId);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/meals`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ category_id: otherCategoryId, name: 'Cross-restaurant meal', base_price: 1000 });

    expect(res.status).toBe(400);
  });

  it('validates required fields', async () => {
    const restaurantId = await createRestaurant();
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/meals`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([expect.objectContaining({ field: 'category_id' }), expect.objectContaining({ field: 'name' }), expect.objectContaining({ field: 'base_price' })])
    );
  });
});
