import request from 'supertest';
import { generate as generateTotp } from 'otplib';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createStaff } from '../helpers/fixtures.js';

afterEach(resetDb);
afterAll(closeDb);

const TOTP_OPTIONS = { algorithm: 'SHA1', digits: 6, period: 30 };

async function setUpOwner() {
  const restaurantId = await createRestaurant();
  const owner = await createStaff(restaurantId, 'owner');
  return { restaurantId, owner };
}

describe('POST /v1/auth/mfa/setup', () => {
  it('rejects a non-owner, non-platform-admin role', async () => {
    const restaurantId = await createRestaurant();
    const manager = await createStaff(restaurantId, 'manager');

    const res = await request(app).post('/v1/auth/mfa/setup').set('Authorization', `Bearer ${manager.token}`);
    expect(res.status).toBe(403);
  });

  it('returns a secret and a scannable QR for an owner', async () => {
    const { owner } = await setUpOwner();

    const res = await request(app).post('/v1/auth/mfa/setup').set('Authorization', `Bearer ${owner.token}`);

    expect(res.status).toBe(200);
    expect(res.body.secret).toBeTruthy();
    expect(res.body.otpauth_url).toMatch(/^otpauth:\/\/totp\//);
    expect(res.body.qr_code_data_url).toMatch(/^data:image\/png;base64,/);
  });
});

describe('full MFA lifecycle', () => {
  it('setup -> verify-setup enables MFA, then login requires a TOTP code, then disable turns it back off', async () => {
    const { owner } = await setUpOwner();

    const setup = await request(app).post('/v1/auth/mfa/setup').set('Authorization', `Bearer ${owner.token}`);
    const { secret } = setup.body;

    // Wrong code is rejected.
    const badVerify = await request(app)
      .post('/v1/auth/mfa/verify-setup')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ code: '000000' });
    expect(badVerify.status).toBe(401);

    const validCode = await generateTotp({ secret, ...TOTP_OPTIONS });
    const verify = await request(app)
      .post('/v1/auth/mfa/verify-setup')
      .set('Authorization', `Bearer ${owner.token}`)
      .send({ code: validCode });
    expect(verify.status).toBe(200);

    // Login now stops at a challenge instead of issuing real tokens.
    const login = await request(app).post('/v1/auth/login').send({ email: owner.email, password: owner.password });
    expect(login.status).toBe(200);
    expect(login.body.mfa_required).toBe(true);
    expect(login.body.access_token).toBeUndefined();

    // Wrong code at the login step is rejected too.
    const badLoginVerify = await request(app)
      .post('/v1/auth/mfa/verify-login')
      .send({ challenge_token: login.body.challenge_token, code: '000000' });
    expect(badLoginVerify.status).toBe(401);

    const loginCode = await generateTotp({ secret, ...TOTP_OPTIONS });
    const loginVerify = await request(app)
      .post('/v1/auth/mfa/verify-login')
      .send({ challenge_token: login.body.challenge_token, code: loginCode });
    expect(loginVerify.status).toBe(200);
    expect(loginVerify.body.access_token).toBeTruthy();
    expect(loginVerify.body.refresh_token).toBeTruthy();

    // Disable requires both the password AND a valid code.
    const disableWrongPassword = await request(app)
      .post('/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${loginVerify.body.access_token}`)
      .send({ password: 'WrongPassword!', code: await generateTotp({ secret, ...TOTP_OPTIONS }) });
    expect(disableWrongPassword.status).toBe(401);

    const disable = await request(app)
      .post('/v1/auth/mfa/disable')
      .set('Authorization', `Bearer ${loginVerify.body.access_token}`)
      .send({ password: owner.password, code: await generateTotp({ secret, ...TOTP_OPTIONS }) });
    expect(disable.status).toBe(200);

    // Login now succeeds directly again, no challenge.
    const finalLogin = await request(app).post('/v1/auth/login').send({ email: owner.email, password: owner.password });
    expect(finalLogin.status).toBe(200);
    expect(finalLogin.body.mfa_required).toBeUndefined();
    expect(finalLogin.body.access_token).toBeTruthy();
  });
});
