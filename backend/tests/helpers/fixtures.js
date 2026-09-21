import bcrypt from 'bcryptjs';

import { pool } from '../../src/db.js';
import { generateToken, generateGuestToken } from '../../src/auth.js';

let counter = 0;
/** A short unique-ish suffix per call, so parallel test files (and repeated calls within one) never collide on unique columns like email/order_number. */
function unique() {
  counter += 1;
  return `${Date.now()}_${counter}`;
}

export async function createRestaurant(overrides = {}) {
  const result = await pool.query(
    `INSERT INTO restaurants (name, email, address, city, country, latitude, longitude, max_guest_distance_meters, tax_rate, service_charge_rate, is_active)
     VALUES ($1, $2, 'Test Address', 'Lagos', 'Nigeria', 6.5244, 3.3792, 150, 0.075, 0.05, TRUE)
     RETURNING id`,
    [overrides.name ?? `Test Restaurant ${unique()}`, overrides.email ?? `restaurant_${unique()}@example.com`]
  );
  return result.rows[0].id;
}

/** Creates a users row + restaurant_staff row for it, and returns a ready-to-use Bearer token alongside the ids. */
export async function createStaff(restaurantId, role, overrides = {}) {
  const email = overrides.email ?? `staff_${unique()}@example.com`;
  const passwordHash = await bcrypt.hash('TestPass123!', 4); // low cost factor — speed, not security, in tests
  const user = await pool.query(`INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id`, [email, passwordHash]);
  const userId = user.rows[0].id;

  const staff = await pool.query(
    `INSERT INTO restaurant_staff (restaurant_id, user_id, name, display_name, role, is_active)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [restaurantId, userId, overrides.name ?? 'Test Staff', overrides.displayName ?? null, role, overrides.isActive ?? true]
  );

  return { userId, staffId: staff.rows[0].id, email, password: 'TestPass123!', token: generateToken(userId) };
}

export async function createTable(restaurantId, tableNumber, overrides = {}) {
  const result = await pool.query(
    `INSERT INTO tables (restaurant_id, table_number, qr_code_unique_id) VALUES ($1, $2, $3) RETURNING id, qr_code_unique_id`,
    [restaurantId, tableNumber, overrides.qrCodeUniqueId ?? `qr_${unique()}`]
  );
  return result.rows[0];
}

/** menu -> category -> meal, the minimum needed for anything order-related. */
export async function createMenuWithMeal(restaurantId, mealOverrides = {}) {
  const menu = await pool.query(`INSERT INTO menus (restaurant_id, name, is_active) VALUES ($1, 'Test Menu', TRUE) RETURNING id`, [restaurantId]);
  const category = await pool.query(`INSERT INTO meal_categories (menu_id, name) VALUES ($1, 'Test Category') RETURNING id`, [menu.rows[0].id]);
  const meal = await pool.query(
    `INSERT INTO meals (category_id, restaurant_id, name, base_price, is_available, is_low_calorie, is_high_protein, is_vegan, estimated_prep_time_minutes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id, name, base_price`,
    [
      category.rows[0].id,
      restaurantId,
      mealOverrides.name ?? 'Test Meal',
      mealOverrides.basePrice ?? 2000,
      mealOverrides.isAvailable ?? true,
      mealOverrides.isLowCalorie ?? false,
      mealOverrides.isHighProtein ?? false,
      mealOverrides.isVegan ?? false,
      mealOverrides.prepTime ?? 10,
    ]
  );
  return { menuId: menu.rows[0].id, categoryId: category.rows[0].id, mealId: meal.rows[0].id, mealName: meal.rows[0].name, basePrice: Number(meal.rows[0].base_price) };
}

/** Adds an ingredient to a meal with a given removal policy — for exercising the allergen removal-policy engine (orders.test.js). */
export async function addIngredientToMeal(mealId, restaurantId, overrides = {}) {
  const ingredient = await pool.query(
    `INSERT INTO ingredients (restaurant_id, name, allergen_type, is_allergen) VALUES ($1, $2, $3, $4) RETURNING id`,
    [restaurantId, overrides.name ?? `Test Ingredient ${unique()}`, overrides.allergenType ?? 'none', overrides.isAllergen ?? false]
  );
  await pool.query(
    `INSERT INTO meal_ingredients (meal_id, ingredient_id, removal_policy, removal_policy_reason) VALUES ($1, $2, $3, $4)`,
    [mealId, ingredient.rows[0].id, overrides.removalPolicy ?? 'can_remove', overrides.removalPolicyReason ?? null]
  );
  return ingredient.rows[0].id;
}

/** An open table_sittings row — the "visit" grouping bills/orders attach to. */
export async function createSitting(restaurantId, tableId) {
  const result = await pool.query(
    `INSERT INTO table_sittings (restaurant_id, table_id) VALUES ($1, $2) RETURNING id`,
    [restaurantId, tableId]
  );
  return result.rows[0].id;
}

/** A proximity-verified guest session (as if POST /v1/tables/:qrCodeId/scan had already run) + its Bearer token. */
export async function createGuestSession(restaurantId, tableId, overrides = {}) {
  let guestProfileId = overrides.guestProfileId ?? null;
  if (!guestProfileId && overrides.phoneNumber) {
    const profile = await pool.query(
      `INSERT INTO guest_profiles (restaurant_id, phone_number, guest_name) VALUES ($1, $2, $3) RETURNING id`,
      [restaurantId, overrides.phoneNumber, overrides.guestName ?? 'Test Guest']
    );
    guestProfileId = profile.rows[0].id;
  }

  const sittingId = overrides.sittingId ?? (await createSitting(restaurantId, tableId));

  const session = await pool.query(
    `INSERT INTO guest_sessions (restaurant_id, table_id, guest_profile_id, sitting_id, scan_latitude, scan_longitude, distance_meters, expires_at)
     VALUES ($1, $2, $3, $4, 6.5244, 3.3792, 10, NOW() + INTERVAL '4 hours') RETURNING id`,
    [restaurantId, tableId, guestProfileId, sittingId]
  );

  return {
    sessionId: session.rows[0].id,
    guestProfileId,
    sittingId,
    token: generateGuestToken(session.rows[0].id, { tableId, restaurantId }),
  };
}

export async function createOrder(restaurantId, tableId, overrides = {}) {
  const result = await pool.query(
    `INSERT INTO orders (restaurant_id, table_id, guest_profile_id, sitting_id, bill_id, order_number, status, subtotal, tax, service_charge, total_amount, tip_amount, confirmed_at, ready_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
     RETURNING id, total_amount, tip_amount, sitting_id, bill_id`,
    [
      restaurantId,
      tableId,
      overrides.guestProfileId ?? null,
      overrides.sittingId ?? null,
      overrides.billId ?? null,
      overrides.orderNumber ?? `ORD-TEST-${unique()}`,
      overrides.status ?? 'placed',
      overrides.subtotal ?? 2000,
      overrides.tax ?? 150,
      overrides.serviceCharge ?? 100,
      overrides.totalAmount ?? 2250,
      overrides.tipAmount ?? 0,
      overrides.confirmedAt ?? null,
      overrides.readyAt ?? null,
    ]
  );
  return result.rows[0];
}
