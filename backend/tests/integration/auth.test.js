import request from 'supertest';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';

afterEach(resetDb);
afterAll(closeDb);

describe('POST /v1/auth/register', () => {
  it('creates a restaurant + owner account', async () => {
    const res = await request(app).post('/v1/auth/register').send({
      restaurant_name: 'Test Bistro',
      owner_name: 'Owner Olu',
      email: 'owner@testbistro.com',
      password: 'SecurePass123!',
    });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Test Bistro', email: 'owner@testbistro.com', status: 'active' });
  });

  it('rejects a duplicate email with 409', async () => {
    const payload = {
      restaurant_name: 'Test Bistro',
      owner_name: 'Owner Olu',
      email: 'dupe@testbistro.com',
      password: 'SecurePass123!',
    };
    await request(app).post('/v1/auth/register').send(payload);
    const res = await request(app).post('/v1/auth/register').send(payload);

    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
  });

  it('rejects a short password with 400', async () => {
    const res = await request(app).post('/v1/auth/register').send({
      restaurant_name: 'Test Bistro',
      owner_name: 'Owner Olu',
      email: 'shortpw@testbistro.com',
      password: 'short',
    });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/auth/login', () => {
  const credentials = { email: 'login@testbistro.com', password: 'SecurePass123!' };

  beforeEach(async () => {
    await request(app).post('/v1/auth/register').send({
      restaurant_name: 'Login Bistro',
      owner_name: 'Owner Olu',
      ...credentials,
    });
  });

  it('logs in with correct credentials and returns a usable token', async () => {
    const res = await request(app).post('/v1/auth/login').send(credentials);

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('access_token');
    expect(res.body.user).toMatchObject({ email: credentials.email, role: 'owner' });

    const me = await request(app).get('/v1/me').set('Authorization', `Bearer ${res.body.access_token}`);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe(credentials.email);
  });

  it('rejects the wrong password with a generic 401 (no user-enumeration signal)', async () => {
    const res = await request(app).post('/v1/auth/login').send({ email: credentials.email, password: 'WrongPassword1!' });
    expect(res.status).toBe(401);

    const unknownEmail = await request(app).post('/v1/auth/login').send({ email: 'nobody@nowhere.com', password: 'WrongPassword1!' });
    expect(unknownEmail.status).toBe(401);
    expect(unknownEmail.body.error.message).toBe(res.body.error.message);
  });
});
