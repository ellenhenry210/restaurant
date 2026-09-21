import { pool } from '../db.js';

// Every function here takes an optional `executor` (a pg Pool or a
// checked-out Client), defaulting to the shared pool. This is what lets
// orderController.create() run every one of these calls against the
// SAME client inside a single transaction (passing its `client` as
// executor) while findById()/findOrderItems() etc. can also be called
// standalone against the pool for the read-only status endpoint. A model
// function that always used the module-level pool directly couldn't
// participate in a caller's transaction at all.

/** @returns {Promise<number|null>} human-friendly table number, for the kitchen display (realtime.js) — orders only store table_id. */
export async function findTableNumber(tableId, executor = pool) {
  const result = await executor.query('SELECT table_number FROM tables WHERE id = $1', [tableId]);
  return result.rows[0]?.table_number ?? null;
}

/** @returns {Promise<{ tax_rate: string, service_charge_rate: string }>} */
export async function findRestaurantRates(restaurantId, executor = pool) {
  const result = await executor.query('SELECT tax_rate, service_charge_rate FROM restaurants WHERE id = $1', [restaurantId]);
  return result.rows[0];
}

/** @returns {Promise<string|null>} the guest_profiles.id, or null if none exists yet */
export async function findGuestProfileId(restaurantId, phoneNumber, executor = pool) {
  const result = await executor.query(
    'SELECT id FROM guest_profiles WHERE restaurant_id = $1 AND phone_number = $2',
    [restaurantId, phoneNumber]
  );
  return result.rows[0]?.id ?? null;
}

/** @returns {Promise<string>} the newly created guest_profiles.id */
export async function createGuestProfile(restaurantId, phoneNumber, guestName, executor = pool) {
  const result = await executor.query(
    'INSERT INTO guest_profiles (restaurant_id, phone_number, guest_name) VALUES ($1, $2, $3) RETURNING id',
    [restaurantId, phoneNumber, guestName ?? null]
  );
  return result.rows[0].id;
}

export async function linkGuestSessionToProfile(sessionId, guestProfileId, executor = pool) {
  await executor.query('UPDATE guest_sessions SET guest_profile_id = $1 WHERE id = $2', [guestProfileId, sessionId]);
}

/**
 * A meal, only if it belongs to this restaurant — used both to fetch
 * pricing and to enforce that a guest can't order a meal from a
 * restaurant other than the one their session is scoped to.
 * @returns {Promise<{id, name, base_price, is_available}|null>}
 */
export async function findOrderableMeal(mealId, restaurantId, executor = pool) {
  const result = await executor.query(
    'SELECT id, name, base_price, is_available FROM meals WHERE id = $1 AND restaurant_id = $2',
    [mealId, restaurantId]
  );
  return result.rows[0] ?? null;
}

/** @returns {Promise<{ingredient_id, removal_policy, removal_policy_reason}[]>} */
export async function findRemovalPolicies(mealId, ingredientIds, executor = pool) {
  const result = await executor.query(
    `SELECT ingredient_id, removal_policy, removal_policy_reason
     FROM meal_ingredients
     WHERE meal_id = $1 AND ingredient_id = ANY($2::uuid[])`,
    [mealId, ingredientIds]
  );
  return result.rows;
}

/** @returns {Promise<{id, additional_price}[]>} only the addons that are actually valid+available for this meal */
export async function findValidAddons(mealId, addonIds, executor = pool) {
  const result = await executor.query(
    'SELECT id, additional_price FROM meal_addons WHERE meal_id = $1 AND id = ANY($2::uuid[]) AND is_available = TRUE',
    [mealId, addonIds]
  );
  return result.rows;
}

/** @returns {Promise<number>} the next value from order_number_seq (migration 007) */
export async function nextOrderNumberSeq(executor = pool) {
  const result = await executor.query(`SELECT nextval('order_number_seq') AS n`);
  return result.rows[0].n;
}

/**
 * Insert the order row.
 * @param {object} data { restaurantId, tableId, guestProfileId, orderNumber, subtotal, tax, serviceCharge, totalAmount, tip, specialRequests }
 * @returns {Promise<object>} the inserted row (id, order_number, status, subtotal, tax, service_charge, total_amount, tip_amount, currency, placed_at)
 */
export async function insertOrder(data, executor = pool) {
  const result = await executor.query(
    `INSERT INTO orders (restaurant_id, table_id, guest_profile_id, order_number, subtotal, tax, service_charge, total_amount, tip_amount, special_requests)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id, order_number, status, subtotal, tax, service_charge, total_amount, tip_amount, currency, placed_at`,
    [
      data.restaurantId,
      data.tableId,
      data.guestProfileId,
      data.orderNumber,
      data.subtotal,
      data.tax,
      data.serviceCharge,
      data.totalAmount,
      data.tip,
      data.specialRequests,
    ]
  );
  return result.rows[0];
}

/**
 * Insert one order_items row.
 * @param {object} item { orderId, mealId, mealName, mealPrice, quantity, removedIngredients, allergenCautionAcknowledged, addedAddons, specialRequest }
 * @returns {Promise<object>} the inserted row (id, meal_id, meal_name, meal_price, quantity, status)
 */
export async function insertOrderItem(item, executor = pool) {
  const result = await executor.query(
    `INSERT INTO order_items (order_id, meal_id, meal_name, meal_price, quantity, removed_ingredients, allergen_caution_acknowledged, added_addons, special_request)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, meal_id, meal_name, meal_price, quantity, status`,
    [
      item.orderId,
      item.mealId,
      item.mealName,
      item.mealPrice,
      item.quantity,
      item.removedIngredients,
      item.allergenCautionAcknowledged,
      item.addedAddons,
      item.specialRequest,
    ]
  );
  return result.rows[0];
}

/**
 * @returns {Promise<object|null>} includes payment_status/payment_reference
 *   — added 2026-09-18, previously missing here even though the payment
 *   flow (paymentController.js) has written them since migration 010;
 *   the guest-facing order-status page needs to know whether to show a
 *   "Pay with Paystack" button.
 */
export async function findById(orderId, executor = pool) {
  const result = await executor.query(
    `SELECT id, restaurant_id, table_id, order_number, status,
            placed_at, confirmed_at, ready_at, served_at, cancelled_at,
            estimated_ready_time, subtotal, tax, service_charge, total_amount,
            tip_amount, currency, special_requests, payment_status, payment_reference
     FROM orders
     WHERE id = $1`,
    [orderId]
  );
  return result.rows[0] ?? null;
}

/** @returns {Promise<object[]>} */
export async function findOrderItems(orderId, executor = pool) {
  const result = await executor.query(
    `SELECT id, meal_id, meal_name, meal_price, quantity, status, special_request
     FROM order_items
     WHERE order_id = $1
     ORDER BY created_at ASC`,
    [orderId]
  );
  return result.rows;
}

/**
 * Whoever is currently assigned to serve this table, if anyone —
 * "the guest should know the staff that is assigned to serving them."
 * @returns {Promise<{name, display_name, role}|null>}
 */
export async function findAssignedServer(tableId, executor = pool) {
  const result = await executor.query(
    `SELECT rs.name, rs.display_name, rs.role
     FROM table_assignments ta
     JOIN restaurant_staff rs ON rs.id = ta.staff_id
     WHERE ta.table_id = $1 AND ta.unassigned_at IS NULL`,
    [tableId]
  );
  return result.rows[0] ?? null;
}
