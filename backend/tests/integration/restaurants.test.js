import request from 'supertest';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

describe('GET /v1/restaurants', () => {
  it('lists active restaurants, publicly, without leaking internal fields', async () => {
    await createRestaurant({ name: 'Public Bistro' });

    const res = await request(app).get('/v1/restaurants');

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].name).toBe('Public Bistro');
    expect(res.body.data[0]).not.toHaveProperty('email');
    expect(res.body.data[0]).not.toHaveProperty('max_guest_distance_meters');
  });
});

describe('GET /v1/restaurants/:id', () => {
  it('returns 404 for a nonexistent (but well-formed) id', async () => {
    const res = await request(app).get('/v1/restaurants/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns 404 (not 500) for a malformed id', async () => {
    const res = await request(app).get('/v1/restaurants/not-a-uuid');
    expect(res.status).toBe(404);
  });
});
