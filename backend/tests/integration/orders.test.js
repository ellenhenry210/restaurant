import request from 'supertest';
import { jest } from '@jest/globals';

import app from '../../src/app.js';
import { resetDb, closeDb } from '../helpers/db.js';
import { createRestaurant, createTable, createMenuWithMeal, addIngredientToMeal, createGuestSession } from '../helpers/fixtures.js';

// Integration tests import app.js directly, with no real HTTP server/
// Socket.io behind it — orderController.js's emitNewOrder() call is
// expected to fail every time here (by design: a broadcast failure never
// affects the HTTP response, it's only logged). Silencing the expected
// noise, not the assertions.
let consoleErrorSpy;
beforeAll(() => {
  consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterAll(() => {
  consoleErrorSpy.mockRestore();
  return closeDb();
});
afterEach(resetDb);

async function setUp(mealOverrides = {}) {
  const restaurantId = await createRestaurant();
  const table = await createTable(restaurantId, 1);
  const { mealId, mealName } = await createMenuWithMeal(restaurantId, mealOverrides);
  const guest = await createGuestSession(restaurantId, table.id, { phoneNumber: '+2348012345678' });
  return { restaurantId, table, mealId, mealName, guest };
}

describe('POST /v1/orders', () => {
  it('rejects an unauthenticated request', async () => {
    const res = await request(app).post('/v1/orders').send({});
    expect(res.status).toBe(401);
  });

  it('places a simple order and computes tax/service charge/grand_total', async () => {
    const { mealId, guest } = await setUp({ basePrice: 2000 });

    const res = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 2 }], tip_amount: 100 });

    expect(res.status).toBe(201);
    // DECIMAL columns come back from pg as strings (avoids float
    // precision loss) — Number(...) here, not a fix to the API itself.
    // restaurant fixture: tax_rate 0.075, service_charge_rate 0.05 on a 4000 subtotal
    expect(Number(res.body.subtotal)).toBe(4000);
    expect(Number(res.body.tax)).toBe(300);
    expect(Number(res.body.service_charge)).toBe(200);
    expect(Number(res.body.total_amount)).toBe(4500);
    expect(res.body.grand_total).toBe(4600); // computed in JS already — a real number, not a DECIMAL passthrough
    expect(res.body.items).toHaveLength(1);
  });

  it('cannot_remove policy blocks the order with 403', async () => {
    const { restaurantId, mealId, guest } = await setUp();
    const ingredientId = await addIngredientToMeal(mealId, restaurantId, { removalPolicy: 'cannot_remove', removalPolicyReason: "Can't be separated" });

    const res = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1, removed_ingredients: [ingredientId] }] });

    expect(res.status).toBe(403);
    expect(res.body.error.message).toContain("Can't be separated");
  });

  it('caution policy requires acknowledgment, else 400', async () => {
    const { restaurantId, mealId, guest } = await setUp();
    const ingredientId = await addIngredientToMeal(mealId, restaurantId, { removalPolicy: 'caution' });

    const unacknowledged = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1, removed_ingredients: [ingredientId] }] });
    expect(unacknowledged.status).toBe(400);

    const acknowledged = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({
        phone_number: '+2348012345678',
        items: [{ meal_id: mealId, quantity: 1, removed_ingredients: [ingredientId], allergen_caution_acknowledged: true }],
      });
    expect(acknowledged.status).toBe(201);
  });

  it('rejects an unavailable meal with 400', async () => {
    const { mealId, guest } = await setUp({ isAvailable: false });

    const res = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });

    expect(res.status).toBe(400);
  });
});

describe('GET /v1/orders/:id', () => {
  it('rejects a guest checking an order from a different table', async () => {
    const { mealId, guest, restaurantId } = await setUp();
    const created = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });

    const otherTable = await createTable(restaurantId, 2);
    const otherGuest = await createGuestSession(restaurantId, otherTable.id, { phoneNumber: '+2348099999999' });

    const res = await request(app).get(`/v1/orders/${created.body.id}`).set('Authorization', `Bearer ${otherGuest.token}`);
    expect(res.status).toBe(403);
  });

  it('includes payment_status — the guest-facing order-status page needs it to decide whether to show a Pay button', async () => {
    const { mealId, guest } = await setUp();
    const created = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });

    const res = await request(app).get(`/v1/orders/${created.body.id}`).set('Authorization', `Bearer ${guest.token}`);
    expect(res.body.payment_status).toBe('pending');
  });
});

describe('PATCH /v1/orders/:id/cancel', () => {
  it('rejects a guest cancelling an order from a different table', async () => {
    const { mealId, guest, restaurantId } = await setUp();
    const created = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });

    const otherTable = await createTable(restaurantId, 2);
    const otherGuest = await createGuestSession(restaurantId, otherTable.id, { phoneNumber: '+2348099999999' });

    const res = await request(app).patch(`/v1/orders/${created.body.id}/cancel`).set('Authorization', `Bearer ${otherGuest.token}`);
    expect(res.status).toBe(403);
  });

  it('cancels a placed order', async () => {
    const { mealId, guest } = await setUp();
    const created = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });

    const res = await request(app).patch(`/v1/orders/${created.body.id}/cancel`).set('Authorization', `Bearer ${guest.token}`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('cancelled');
  });

  it('rejects cancelling an order that is already preparing', async () => {
    const { mealId, guest, restaurantId } = await setUp();
    const created = await request(app)
      .post('/v1/orders')
      .set('Authorization', `Bearer ${guest.token}`)
      .send({ phone_number: '+2348012345678', items: [{ meal_id: mealId, quantity: 1 }] });

    const manager = await (await import('../helpers/fixtures.js')).createStaff(restaurantId, 'manager');
    await request(app).patch(`/v1/restaurants/${restaurantId}/orders/${created.body.id}/status`).set('Authorization', `Bearer ${manager.token}`).send({ status: 'confirmed' });
    await request(app).patch(`/v1/restaurants/${restaurantId}/orders/${created.body.id}/status`).set('Authorization', `Bearer ${manager.token}`).send({ status: 'preparing' });

    const res = await request(app).patch(`/v1/orders/${created.body.id}/cancel`).set('Authorization', `Bearer ${guest.token}`);
    expect(res.status).toBe(409);
  });
});
