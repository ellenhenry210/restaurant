import request from 'supertest';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createStaff, createTable } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

describe('POST /v1/restaurants/:restaurantId/tables/:tableId/assign', () => {
  it('rejects a missing staff_id', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/tables/${table.id}/assign`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({});

    expect(res.status).toBe(400);
  });

  it('assigns a staff member and surfaces them via display_name', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const manager = await createStaff(restaurantId, 'manager');
    const waiter = await createStaff(restaurantId, 'waiter', { displayName: 'Wai' });

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/tables/${table.id}/assign`)
      .set('Authorization', `Bearer ${manager.token}`)
      .send({ staff_id: waiter.staffId });

    expect(res.status).toBe(201);
    expect(res.body.staff).toMatchObject({ name: 'Wai', role: 'waiter' });
  });
});

describe('POST /v1/restaurants/:restaurantId/tables/:tableId/unassign', () => {
  it('is a no-op success even when nobody is assigned', async () => {
    const restaurantId = await createRestaurant();
    const table = await createTable(restaurantId, 1);
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app)
      .post(`/v1/restaurants/${restaurantId}/tables/${table.id}/unassign`)
      .set('Authorization', `Bearer ${manager.token}`);

    expect(res.status).toBe(200);
    expect(res.body.was_assigned).toBe(false);
  });
});
