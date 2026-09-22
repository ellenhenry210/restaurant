import request from 'supertest';
import { jest } from '@jest/globals';

import app from '../../src/app.js';
import { pool } from '../../src/db.js';
import { resetDb, closeDb } from '../helpers/db.js';

let consoleErrorSpy;
beforeAll(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  jest.restoreAllMocks();
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  return resetDb();
});
afterAll(() => {
  consoleErrorSpy.mockRestore();
  return closeDb();
});

async function registerAndLogin(overrides = {}) {
  const email = overrides.email ?? `owner_${Date.now()}_${Math.random()}@example.com`;
  const password = 'TestPass123!';
  await request(app)
    .post('/v1/auth/register')
    .send({ restaurant_name: 'Test Restaurant', owner_name: 'Test Owner', email, password });
  const login = await request(app).post('/v1/auth/login').send({ email, password });
  return { email, password, ...login.body };
}

describe('POST /v1/auth/login', () => {
  it('now also returns a refresh_token alongside the access token', async () => {
    const { refresh_token: refreshToken } = await registerAndLogin();
    expect(typeof refreshToken).toBe('string');
    expect(refreshToken.length).toBeGreaterThan(20);
  });
});

describe('POST /v1/auth/refresh', () => {
  it('rejects a missing refresh_token', async () => {
    const res = await request(app).post('/v1/auth/refresh').send({});
    expect(res.status).toBe(400);
  });

  it('rejects an unknown refresh token', async () => {
    const res = await request(app).post('/v1/auth/refresh').send({ refresh_token: 'not_a_real_token' });
    expect(res.status).toBe(401);
  });

  it('issues a new token pair and rotates (invalidates) the old refresh token', async () => {
    const { refresh_token: firstRefresh } = await registerAndLogin();

    const res = await request(app).post('/v1/auth/refresh').send({ refresh_token: firstRefresh });
    expect(res.status).toBe(200);
    expect(res.body.access_token).toBeTruthy();
    expect(res.body.refresh_token).toBeTruthy();
    expect(res.body.refresh_token).not.toBe(firstRefresh);

    // The rotated-out token can't be reused.
    const reuse = await request(app).post('/v1/auth/refresh').send({ refresh_token: firstRefresh });
    expect(reuse.status).toBe(401);
  });
});

describe('POST /v1/auth/logout', () => {
  it('revokes the refresh token so it can no longer be used to refresh', async () => {
    const { refresh_token: refreshToken } = await registerAndLogin();

    const logout = await request(app).post('/v1/auth/logout').send({ refresh_token: refreshToken });
    expect(logout.status).toBe(200);

    const res = await request(app).post('/v1/auth/refresh').send({ refresh_token: refreshToken });
    expect(res.status).toBe(401);
  });

  it('is a no-op 200 for an unknown token, not an error', async () => {
    const res = await request(app).post('/v1/auth/logout').send({ refresh_token: 'garbage' });
    expect(res.status).toBe(200);
  });
});

describe('password reset flow', () => {
  it('forgot-password always returns 200 with a generic message, even for an unknown email', async () => {
    const res = await request(app).post('/v1/auth/forgot-password').send({ email: 'nobody@example.com' });
    expect(res.status).toBe(200);
    expect(res.body.message).toMatch(/if an account exists/i);
  });

  it('rejects reset-password with an invalid token', async () => {
    const res = await request(app).post('/v1/auth/reset-password').send({ token: 'not_real', password: 'NewPass123!' });
    expect(res.status).toBe(401);
  });

  it('resets the password, revokes existing sessions, and the old password stops working', async () => {
    const { email, password: oldPassword, refresh_token: oldRefreshToken } = await registerAndLogin();

    await request(app).post('/v1/auth/forgot-password').send({ email });
    const tokenRow = await pool.query(
      `SELECT prt.id FROM password_reset_tokens prt JOIN users u ON u.id = prt.user_id WHERE u.email = $1 ORDER BY prt.created_at DESC LIMIT 1`,
      [email]
    );
    expect(tokenRow.rows).toHaveLength(1);

    // The raw token isn't recoverable from the hash — exercise reset-password
    // via a freshly-issued raw token instead, same mechanism, so this test
    // verifies real behavior rather than reaching into internals.
    const newPassword = 'BrandNewPass456!';

    // Simulate "the guest clicked the emailed link" using the model
    // directly for the raw token, since forgot-password only logs it —
    // there's no email inbox in a test to read it from.
    const authModel = await import('../../src/models/authModel.js');
    const { hashOpaqueToken } = await import('../../src/auth.js');
    const crypto = await import('node:crypto');
    const rawToken = crypto.randomBytes(32).toString('hex');
    const userRow = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    await authModel.insertPasswordResetToken(userRow.rows[0].id, hashOpaqueToken(rawToken), new Date(Date.now() + 60000));

    const res = await request(app).post('/v1/auth/reset-password').send({ token: rawToken, password: newPassword });
    expect(res.status).toBe(200);

    // Old refresh token no longer works.
    const refreshAttempt = await request(app).post('/v1/auth/refresh').send({ refresh_token: oldRefreshToken });
    expect(refreshAttempt.status).toBe(401);

    // Old password no longer works; new one does.
    const oldLogin = await request(app).post('/v1/auth/login').send({ email, password: oldPassword });
    expect(oldLogin.status).toBe(401);
    const newLogin = await request(app).post('/v1/auth/login').send({ email, password: newPassword });
    expect(newLogin.status).toBe(200);
  });

  it('rejects reusing an already-used reset token', async () => {
    const { email } = await registerAndLogin();
    const authModel = await import('../../src/models/authModel.js');
    const { hashOpaqueToken } = await import('../../src/auth.js');
    const crypto = await import('node:crypto');
    const rawToken = crypto.randomBytes(32).toString('hex');
    const userRow = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    await authModel.insertPasswordResetToken(userRow.rows[0].id, hashOpaqueToken(rawToken), new Date(Date.now() + 60000));

    const first = await request(app).post('/v1/auth/reset-password').send({ token: rawToken, password: 'FirstReset123!' });
    expect(first.status).toBe(200);

    const second = await request(app).post('/v1/auth/reset-password').send({ token: rawToken, password: 'SecondReset123!' });
    expect(second.status).toBe(401);
  });
});
