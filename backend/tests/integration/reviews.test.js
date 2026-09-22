import request from 'supertest';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createTable, createMenuWithMeal, createGuestSession, createStaff } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

async function setUpOrderedMeal() {
  const restaurantId = await createRestaurant();
  const table = await createTable(restaurantId, 1);
  const { mealId } = await createMenuWithMeal(restaurantId);
  const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348012345678' });
  const order = await request(app)
    .post('/v1/orders')
    .set('Authorization', `Bearer ${guest.token}`)
    .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });
  return { restaurantId, table, mealId, guest, orderId: order.body.id };
}

describe('POST /v1/orders/:orderId/reviews', () => {
  it('rejects a meal that was not part of the order', async () => {
    const { restaurantId, guest, orderId } = await setUpOrderedMeal();
    const { mealId: otherMealId } = await createMenuWithMeal(restaurantId, { name: 'Other Meal' });

    const res = await request(app)
      .post(`/v1/orders/${orderId}/reviews`)
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ meal_id: otherMealId, rating: 5 });

    expect(res.status).toBe(400);
  });

  it('rejects an order from a different table', async () => {
    const { restaurantId, mealId, orderId } = await setUpOrderedMeal();
    const otherTable = await createTable(restaurantId, 2);
    const otherGuest = await createGuestSession(restaurantId, otherTable.id, { phoneNumber: '+2348099999999' });

    const res = await request(app)
      .post(`/v1/orders/${orderId}/reviews`)
      .set('Authorization', `Bearer ${otherGuest.token}`)
      .send({ meal_id: mealId, rating: 5 });

    expect(res.status).toBe(403);
  });

  it('creates a review and it is publicly listed', async () => {
    const { restaurantId, mealId, guest, orderId } = await setUpOrderedMeal();

    const res = await request(app)
      .post(`/v1/orders/${orderId}/reviews`)
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ meal_id: mealId, rating: 4, review_text: 'Pretty good!' });
    expect(res.status).toBe(201);

    const list = await request(app).get(`/v1/restaurants/${restaurantId}/reviews`);
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0]).toMatchObject({ rating: 4, review_text: 'Pretty good!', response: null });
  });
});

describe('PATCH /v1/reviews/:reviewId', () => {
  it('rejects a guest editing someone else\'s review', async () => {
    const { mealId, guest, orderId } = await setUpOrderedMeal();
    const created = await request(app).post(`/v1/orders/${orderId}/reviews`).set('Authorization', `Bearer ${guest.token}`).send({ meal_id: mealId, rating: 3 });

    const otherRestaurantId = await createRestaurant();
    const otherTable = await createTable(otherRestaurantId, 9);
    const otherGuest = await createGuestSession(otherRestaurantId, otherTable.id, { phoneNumber: '+2348088888888' });

    const res = await request(app).patch(`/v1/reviews/${created.body.id}`).set('Authorization', `Bearer ${otherGuest.token}`).send({ rating: 1 });
    expect(res.status).toBe(403);
  });

  it('allows the reviewer to edit within the window', async () => {
    const { mealId, guest, orderId } = await setUpOrderedMeal();
    const created = await request(app).post(`/v1/orders/${orderId}/reviews`).set('Authorization', `Bearer ${guest.token}`).send({ meal_id: mealId, rating: 3 });

    const res = await request(app).patch(`/v1/reviews/${created.body.id}`).set('Authorization', `Bearer ${guest.token}`).send({ rating: 5, review_text: 'Actually great' });
    expect(res.status).toBe(200);
    expect(res.body.rating).toBe(5);
  });

  it('rejects editing after the 48h window', async () => {
    const { mealId, guest, orderId } = await setUpOrderedMeal();
    const created = await request(app).post(`/v1/orders/${orderId}/reviews`).set('Authorization', `Bearer ${guest.token}`).send({ meal_id: mealId, rating: 3 });
    await pool.query(`UPDATE guest_reviews SET created_at = NOW() - INTERVAL '49 hours' WHERE id = $1`, [created.body.id]);

    const res = await request(app).patch(`/v1/reviews/${created.body.id}`).set('Authorization', `Bearer ${guest.token}`).send({ rating: 5 });
    expect(res.status).toBe(409);
  });
});

describe('staff review actions', () => {
  it('rejects a waiter replying to a review (reply_to_review is manager+)', async () => {
    const { restaurantId, mealId, guest, orderId } = await setUpOrderedMeal();
    const created = await request(app).post(`/v1/orders/${orderId}/reviews`).set('Authorization', `Bearer ${guest.token}`).send({ meal_id: mealId, rating: 3 });
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/reviews/${created.body.id}/responses`)
      .set('Authorization', `Bearer ${waiter.token}`)
      .send({ response_text: 'Thanks!' });
    expect(res.status).toBe(403);
  });

  it('lets a manager reply, and the response shows up in the public listing', async () => {
    const { restaurantId, mealId, guest, orderId } = await setUpOrderedMeal();
    const created = await request(app).post(`/v1/orders/${orderId}/reviews`).set('Authorization', `Bearer ${guest.token}`).send({ meal_id: mealId, rating: 3 });
    const manager = await createStaff(restaurantId, 'manager');

    const reply = await request(app)
      .post(`/v1/restaurants/${restaurantId}/reviews/${created.body.id}/responses`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ response_text: 'Thanks for the feedback!' });
    expect(reply.status).toBe(201);

    const list = await request(app).get(`/v1/restaurants/${restaurantId}/reviews`);
    expect(list.body.data[0].response).toMatchObject({ text: 'Thanks for the feedback!' });
  });

  it('rejects a manager moderating (moderate_review is owner+)', async () => {
    const { restaurantId, mealId, guest, orderId } = await setUpOrderedMeal();
    const created = await request(app).post(`/v1/orders/${orderId}/reviews`).set('Authorization', `Bearer ${guest.token}`).send({ meal_id: mealId, rating: 3 });
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/reviews/${created.body.id}/moderate`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ is_public: false });
    expect(res.status).toBe(403);
  });

  it('lets an owner remove a review from public view', async () => {
    const { restaurantId, mealId, guest, orderId } = await setUpOrderedMeal();
    const created = await request(app).post(`/v1/orders/${orderId}/reviews`).set('Authorization', `Bearer ${guest.token}`).send({ meal_id: mealId, rating: 3 });
    const owner = await createStaff(restaurantId, 'owner');

    const moderate = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/reviews/${created.body.id}/moderate`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ is_public: false });
    expect(moderate.status).toBe(200);

    const list = await request(app).get(`/v1/restaurants/${restaurantId}/reviews`);
    expect(list.body.data).toHaveLength(0);
  });
});
