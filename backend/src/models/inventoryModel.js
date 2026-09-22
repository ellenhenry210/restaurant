import { pool } from '../db.js';

// mark_out_of_stock (kitchen_staff/manager/owner/system_admin) toggles
// a MEAL's availability — that's the guest-visible "sold out" signal.
// set_inventory_levels (manager/owner/system_admin) is the finer-grained
// action underneath: adjusting an INGREDIENT's actual stock count, which
// is what a kitchen would eventually run out of.

export async function findMealForRestaurant(mealId, restaurantId, executor = pool) {
  const result = await executor.query(`SELECT id, name, is_available FROM meals WHERE id = $1 AND restaurant_id = $2`, [mealId, restaurantId]);
  return result.rows[0] ?? null;
}

export async function setMealAvailability(mealId, isAvailable, executor = pool) {
  const result = await executor.query(
    `UPDATE meals SET is_available = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, name, is_available`,
    [isAvailable, mealId]
  );
  return result.rows[0];
}

export async function findIngredientsByRestaurant(restaurantId, executor = pool) {
  const result = await executor.query(
    `SELECT id, name, allergen_type, is_allergen, current_stock, unit_of_measure, reorder_level, is_active
     FROM ingredients
     WHERE restaurant_id = $1
     ORDER BY name ASC`,
    [restaurantId]
  );
  return result.rows;
}

export async function findIngredientForRestaurant(ingredientId, restaurantId, executor = pool) {
  const result = await executor.query(`SELECT id FROM ingredients WHERE id = $1 AND restaurant_id = $2`, [ingredientId, restaurantId]);
  return result.rows[0] ?? null;
}

export async function setIngredientStock(ingredientId, { currentStock, reorderLevel, isActive }, executor = pool) {
  const result = await executor.query(
    `UPDATE ingredients
     SET current_stock = COALESCE($1, current_stock),
         reorder_level = COALESCE($2, reorder_level),
         is_active = COALESCE($3, is_active),
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING id, name, current_stock, reorder_level, is_active`,
    [currentStock ?? null, reorderLevel ?? null, isActive ?? null, ingredientId]
  );
  return result.rows[0];
}
