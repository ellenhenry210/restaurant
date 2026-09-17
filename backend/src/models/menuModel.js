import { pool } from '../db.js';

/**
 * List a restaurant's menus, with categories_count/meals_count.
 *
 * One query, not N+1: the counts are computed via LEFT JOIN +
 * COUNT(DISTINCT ...) + GROUP BY, in the same query as the menu rows
 * themselves. The tempting-looking alternative — fetch the menus, then
 * loop over them running a "how many meals" query per menu — is the
 * classic N+1 pattern: fine with 2 menus, a real cost with 20. A LEFT
 * JOIN (not INNER) is what makes a menu with zero categories yet still
 * show up (with counts of 0) instead of silently disappearing.
 *
 * @param {string} restaurantId
 * @param {{ activeOnly: boolean }} options
 * @returns {Promise<object[]>}
 */
export async function findMenusByRestaurant(restaurantId, { activeOnly }) {
  const result = await pool.query(
    `SELECT
       m.id, m.name, m.description, m.is_active, m.active_from, m.active_until,
       COUNT(DISTINCT mc.id) AS categories_count,
       COUNT(DISTINCT meals.id) FILTER (WHERE meals.is_available = TRUE) AS meals_count
     FROM menus m
     LEFT JOIN meal_categories mc ON mc.menu_id = m.id
     LEFT JOIN meals ON meals.category_id = mc.id
     WHERE m.restaurant_id = $1
       AND ($2::boolean IS FALSE OR m.is_active = TRUE)
     GROUP BY m.id
     ORDER BY m.created_at ASC`,
    [restaurantId, activeOnly]
  );
  return result.rows;
}

/**
 * Fetch one meal, with its category name joined in.
 * @param {string} mealId
 * @returns {Promise<object|null>}
 */
export async function findMealById(mealId) {
  const result = await pool.query(
    `SELECT meals.*, mc.name AS category_name
     FROM meals
     JOIN meal_categories mc ON mc.id = meals.category_id
     WHERE meals.id = $1`,
    [mealId]
  );
  return result.rows[0] ?? null;
}

/** Bare existence check — used by getIngredients() to distinguish "meal
 * has no ingredients" from "meal doesn't exist" without fetching the
 * whole meal row. */
export async function mealExists(mealId) {
  const result = await pool.query('SELECT id FROM meals WHERE id = $1', [mealId]);
  return result.rows.length > 0;
}

/**
 * Fetch a meal's ingredients, joined with allergen/removal-policy info.
 * @param {string} mealId
 * @returns {Promise<object[]>}
 */
export async function findIngredientsByMealId(mealId) {
  const result = await pool.query(
    `SELECT
       mi.id, i.name, i.allergen_type,
       mi.removal_policy, mi.removal_policy_reason, mi.is_required,
       mi.quantity, mi.unit_of_measure
     FROM meal_ingredients mi
     JOIN ingredients i ON i.id = mi.ingredient_id
     WHERE mi.meal_id = $1
     ORDER BY mi.sort_order ASC`,
    [mealId]
  );
  return result.rows;
}

/**
 * A meal_categories row, only if it belongs to this restaurant (via its
 * menu) — the check that stops a manager creating a meal under a
 * category that belongs to a DIFFERENT restaurant.
 * @returns {Promise<{id}|null>}
 */
export async function findCategoryForRestaurant(categoryId, restaurantId, executor = pool) {
  const result = await executor.query(
    `SELECT mc.id
     FROM meal_categories mc
     JOIN menus m ON m.id = mc.menu_id
     WHERE mc.id = $1 AND m.restaurant_id = $2`,
    [categoryId, restaurantId]
  );
  return result.rows[0] ?? null;
}

/**
 * Insert a new meal. Previously only ever seeded directly via SQL — see
 * SNAPORDER_API_CONTRACTS.md's Menu section, now updated to reflect this.
 * @returns {Promise<object>} the inserted row
 */
export async function insertMeal(data, executor = pool) {
  const result = await executor.query(
    `INSERT INTO meals (
       category_id, restaurant_id, name, description, image_url, base_price,
       calories, protein_grams, carbs_grams, fat_grams, fiber_grams, sodium_mg,
       is_vegan, is_vegetarian, is_gluten_free, is_low_calorie, is_high_protein,
       is_available, estimated_prep_time_minutes
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19)
     RETURNING *`,
    [
      data.categoryId,
      data.restaurantId,
      data.name,
      data.description ?? null,
      data.imageUrl ?? null,
      data.basePrice,
      data.calories ?? null,
      data.proteinGrams ?? null,
      data.carbsGrams ?? null,
      data.fatGrams ?? null,
      data.fiberGrams ?? null,
      data.sodiumMg ?? null,
      data.isVegan ?? false,
      data.isVegetarian ?? false,
      data.isGlutenFree ?? false,
      data.isLowCalorie ?? false,
      data.isHighProtein ?? false,
      data.isAvailable ?? true,
      data.estimatedPrepTimeMinutes ?? null,
    ]
  );
  return result.rows[0];
}

/**
 * Fetch a meal's available addons.
 * @param {string} mealId
 * @returns {Promise<object[]>}
 */
export async function findAddonsByMealId(mealId) {
  const result = await pool.query(
    `SELECT id, name, description, additional_price, max_quantity
     FROM meal_addons
     WHERE meal_id = $1 AND is_available = TRUE
     ORDER BY sort_order ASC`,
    [mealId]
  );
  return result.rows;
}
