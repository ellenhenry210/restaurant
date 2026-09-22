import request from 'supertest';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createStaff } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

describe('POST /v1/restaurants/:restaurantId/staff', () => {
  it('validates required fields', async () => {
    const restaurantId = await createRestaurant();
    const owner = await createStaff(restaurantId, 'owner');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});

    expect(res.status).toBe(400);
    expect(res.body.error.details).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ field: 'email' }),
        expect.objectContaining({ field: 'name' }),
        expect.objectContaining({ field: 'role' }),
      ])
    );
  });

  it('rejects an invalid role', async () => {
    const restaurantId = await createRestaurant();
    const owner = await createStaff(restaurantId, 'owner');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'new@example.com', name: 'New Staff', role: 'ceo', password: 'TestPass123!' });

    expect(res.status).toBe(400);
  });

  it('adds a new staff member with a valid payload', async () => {
    const restaurantId = await createRestaurant();
    const owner = await createStaff(restaurantId, 'owner');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/staff`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ email: 'waiter@example.com', name: 'New Waiter', role: 'waiter', password: 'TestPass123!' });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'New Waiter', role: 'waiter' });
  });
});

describe('PATCH /v1/restaurants/:restaurantId/staff/:staffId', () => {
  it('rejects an omitted display_name', async () => {
    const restaurantId = await createRestaurant();
    const owner = await createStaff(restaurantId, 'owner');
    const waiter = await createStaff(restaurantId, 'waiter');

    const res = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/staff/${waiter.staffId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('updates display_name, and accepts null to clear it', async () => {
    const restaurantId = await createRestaurant();
    const owner = await createStaff(restaurantId, 'owner');
    const waiter = await createStaff(restaurantId, 'waiter');

    const set = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/staff/${waiter.staffId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ display_name: 'Wai' });
    expect(set.status).toBe(200);
    expect(set.body.display_name).toBe('Wai');

    const clear = await request(app)
      .patch(`/v1/restaurants/${restaurantId}/staff/${waiter.staffId}`)
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ display_name: null });
    expect(clear.status).toBe(200);
    expect(clear.body.display_name).toBeNull();
  });
});
