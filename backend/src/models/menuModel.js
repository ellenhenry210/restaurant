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

/** @returns {Promise<{id, name, description, is_active}|null>} — only if it belongs to this restaurant. */
export async function findMenuById(menuId, restaurantId, executor = pool) {
  const result = await executor.query(
    `SELECT id, name, description, is_active FROM menus WHERE id = $1 AND restaurant_id = $2`,
    [menuId, restaurantId]
  );
  return result.rows[0] ?? null;
}

/**
 * A menu's categories, each with its available meals nested — the
 * "listing meals within a specific menu" endpoint flagged as not yet
 * built (SNAPORDER_API_CONTRACTS.md). One query, grouped in JS rather
 * than SQL (no json_agg elsewhere in this codebase; a flat result set +
 * a single pass is simpler and consistent with it) — same N+1 avoidance
 * as findMenusByRestaurant above. LEFT JOIN + a category-only row when a
 * category has zero available meals, so an empty category still shows
 * up rather than silently vanishing.
 * @param {string} menuId
 * @returns {Promise<{id, name, meals: object[]}[]>}
 */
/**
 * @param {boolean} includeUnavailable — false (default) for the guest-
 *   facing menu, where an unavailable meal shouldn't appear at all.
 *   Staff-facing views (the admin menu editor) need the opposite — a
 *   meal marked out of stock has to stay visible, or there'd be no way
 *   to see it again to re-enable it.
 */
export async function findCategoriesWithMealsByMenu(menuId, includeUnavailable = false, executor = pool) {
  const result = await executor.query(
    `SELECT
       mc.id AS category_id, mc.name AS category_name, mc.sort_order AS category_sort_order,
       meals.id AS meal_id, meals.name AS meal_name, meals.description AS meal_description,
       meals.image_url, meals.base_price, meals.currency, meals.is_available,
       meals.calories, meals.protein_grams,
       meals.is_vegan, meals.is_vegetarian, meals.is_gluten_free, meals.is_low_calorie, meals.is_high_protein,
       meals.estimated_prep_time_minutes, meals.sort_order AS meal_sort_order
     FROM meal_categories mc
     LEFT JOIN meals ON meals.category_id = mc.id AND ($2::boolean OR meals.is_available = TRUE)
     WHERE mc.menu_id = $1 AND mc.is_active = TRUE
     ORDER BY mc.sort_order ASC, meals.sort_order ASC`,
    [menuId, includeUnavailable]
  );

  const categoriesById = new Map();
  for (const row of result.rows) {
    if (!categoriesById.has(row.category_id)) {
      categoriesById.set(row.category_id, { id: row.category_id, name: row.category_name, meals: [] });
    }
    if (row.meal_id) {
      categoriesById.get(row.category_id).meals.push({
        id: row.meal_id,
        name: row.meal_name,
        description: row.meal_description,
        image_url: row.image_url,
        base_price: row.base_price,
        currency: row.currency,
        calories: row.calories,
        protein_grams: row.protein_grams,
        is_vegan: row.is_vegan,
        is_vegetarian: row.is_vegetarian,
        is_gluten_free: row.is_gluten_free,
        is_low_calorie: row.is_low_calorie,
        is_high_protein: row.is_high_protein,
        is_available: row.is_available,
        estimated_prep_time_minutes: row.estimated_prep_time_minutes,
      });
    }
  }
  return [...categoriesById.values()];
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
// Whitelisted tag->column mapping — the only thing ever interpolated
// into the query below is a value looked up from this object, never the
// raw query string itself, so this can't become a SQL-injection point
// no matter what a caller sends as ?tags=.
const TAG_COLUMNS = {
  vegan: 'is_vegan',
  vegetarian: 'is_vegetarian',
  gluten_free: 'is_gluten_free',
  low_calorie: 'is_low_calorie',
  high_protein: 'is_high_protein',
};

/**
 * Basic rule-based recommendations (SNAPORDER_STATUS.md's Phase 2 spec:
 * "health goal + allergy -> safe meal", the guest-facing half only —
 * the restaurant-facing "chef suggestion engine" needs demand/margin
 * data this project doesn't have yet, and is correctly Phase 3, not
 * attempted here). Filters on the meal's own existing dietary tags
 * (already in the schema — no separate nutritional-data layer needed
 * for this basic version) and ranks by how often each meal has actually
 * been ordered — a real popularity signal, not a guess.
 * @param {string[]} tags — any of TAG_COLUMNS' keys; unrecognized values are ignored, not rejected.
 */
export async function findRecommendedMeals(restaurantId, tags, limit, executor = pool) {
  const validColumns = tags.map((t) => TAG_COLUMNS[t]).filter(Boolean);
  const tagFilter = validColumns.length > 0 ? `AND ${validColumns.map((c) => `m.${c}`).join(' AND ')}` : '';

  const result = await executor.query(
    `SELECT m.id, m.name, m.description, m.base_price, m.currency,
            m.is_vegan, m.is_vegetarian, m.is_gluten_free, m.is_low_calorie, m.is_high_protein,
            COALESCE(oc.times_ordered, 0) AS times_ordered
     FROM meals m
     LEFT JOIN (SELECT meal_id, SUM(quantity) AS times_ordered FROM order_items GROUP BY meal_id) oc ON oc.meal_id = m.id
     WHERE m.restaurant_id = $1 AND m.is_available = TRUE ${tagFilter}
     ORDER BY times_ordered DESC, m.name ASC
     LIMIT $2`,
    [restaurantId, limit]
  );
  return result.rows.map((r) => ({ ...r, times_ordered: Number(r.times_ordered) }));
}

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
