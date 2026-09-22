import request from 'supertest';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createTable, createMenuWithMeal, createGuestSession, createStaff } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

async function guestWithProfile() {
  const restaurantId = await createRestaurant();
  const table = await createTable(restaurantId, 1);
  const { mealId } = await createMenuWithMeal(restaurantId);
  const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348012345678' });
  await request(app)
    .post('/v1/orders')
    .set('Authorization', `Bearer ${guest.token}`)
    .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });
  return { restaurantId, guest };
}

describe('POST /v1/suggestions', () => {
  it('creates a guest suggestion', async () => {
    const { guest } = await guestWithProfile();
    const res = await request(app)
      .post('/v1/suggestions')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ title: 'Add dark mode', description: 'Please', category: 'guest' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ title: 'Add dark mode', status: 'proposed', upvote_count: 0 });
  });
});

describe('GET /v1/suggestions', () => {
  it('lists suggestions sorted by upvote count', async () => {
    const { guest } = await guestWithProfile();
    const low = await request(app).post('/v1/suggestions').set('Authorization', `Bearer ${guest.token}`).send({ title: 'Low votes' });
    const high = await request(app).post('/v1/suggestions').set('Authorization', `Bearer ${guest.token}`).send({ title: 'High votes' });
    await request(app).post(`/v1/suggestions/${high.body.id}/vote`).set('Authorization', `Bearer ${guest.token}`);

    const res = await request(app).get('/v1/suggestions');
    expect(res.status).toBe(200);
    expect(res.body.data[0].id).toBe(high.body.id);
    expect(res.body.data[0].upvote_count).toBe(1);
    expect(res.body.data.map((s) => s.id)).toContain(low.body.id);
  });
});

describe('POST /v1/suggestions/:id/vote', () => {
  it('rejects a guest session with no linked guest profile yet', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const guestNoProfile = await createGuestSession(restaurantId, table.id);
    const suggestion = await request(app)
      .post('/v1/suggestions')
      .set('Authorization', `Bearer ${(await guestWithProfile()).guest.token}`)
      .send({ title: 'X' });

    const res = await request(app).post(`/v1/suggestions/${suggestion.body.id}/vote`).set('Authorization', `Bearer ${guestNoProfile.token}`);
    expect(res.status).toBe(409);
  });

  it('is idempotent — voting twice only counts once', async () => {
    const { guest } = await guestWithProfile();
    const suggestion = await request(app).post('/v1/suggestions').set('Authorization', `Bearer ${guest.token}`).send({ title: 'X' });

    const first = await request(app).post(`/v1/suggestions/${suggestion.body.id}/vote`).set('Authorization', `Bearer ${guest.token}`);
    expect(first.status).toBe(201);
    expect(first.body.already_voted).toBe(false);

    const second = await request(app).post(`/v1/suggestions/${suggestion.body.id}/vote`).set('Authorization', `Bearer ${guest.token}`);
    expect(second.status).toBe(200);
    expect(second.body.already_voted).toBe(true);

    const list = await request(app).get('/v1/suggestions');
    expect(list.body.data.find((s) => s.id === suggestion.body.id).upvote_count).toBe(1);
  });
});

describe('staff suggestions', () => {
  it('lets any active staff member create a suggestion', async () => {
    const restaurantId = await createRestaurant();
    const waiter = await createStaff(restaurantId, 'waiter');
    const res = await request(app).post(`/v1/restaurants/${restaurantId}/suggestions`).set('Authorization', `Bearer ${waiter.token}`).send({ title: 'Staff idea' });
    expect(res.status).toBe(201);
  });

  it('lets any staff role with vote_suggestion vote', async () => {
    const restaurantId = await createRestaurant();
    const waiter = await createStaff(restaurantId, 'waiter');
    const suggestion = await request(app).post(`/v1/restaurants/${restaurantId}/suggestions`).set('Authorization', `Bearer ${waiter.token}`).send({ title: 'X' });

    const res = await request(app).post(`/v1/restaurants/${restaurantId}/suggestions/${suggestion.body.id}/vote`).set('Authorization', `Bearer ${waiter.token}`);
    expect(res.status).toBe(201);
  });
});

describe('PATCH /v1/suggestions/:id/roadmap-status', () => {
  it('rejects a non-platform-admin', async () => {
    const restaurantId = await createRestaurant();
    const owner = await createStaff(restaurantId, 'owner');
    const suggestion = await request(app).post(`/v1/restaurants/${restaurantId}/suggestions`).set('Authorization', `Bearer ${owner.token}`).send({ title: 'X' });

    const res = await request(app).patch(`/v1/suggestions/${suggestion.body.id}/roadmap-status`).set('Authorization', `Bearer ${owner.token}`).send({ status: 'planned' });
    expect(res.status).toBe(403);
  });

  it('lets a platform admin set the status, marking completed as implemented', async () => {
    const restaurantId = await createRestaurant();
    const owner = await createStaff(restaurantId, 'owner');
    const suggestion = await request(app).post(`/v1/restaurants/${restaurantId}/suggestions`).set('Authorization', `Bearer ${owner.token}`).send({ title: 'X' });

    const { pool } = await import('../../src/db.js');
    await pool.query('INSERT INTO platform_admins (user_id) VALUES ($1)', [owner.userId]);

    const res = await request(app).patch(`/v1/suggestions/${suggestion.body.id}/roadmap-status`).set('Authorization', `Bearer ${owner.token}`).send({ status: 'completed' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ status: 'completed', is_implemented: true });
  });
});
