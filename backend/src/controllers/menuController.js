import { z } from 'zod';

import * as menuModel from '../models/menuModel.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------
// GET /restaurants/:restaurantId/menus
// ---------------------------------------------------------------------
export async function listMenus(req, res) {
  // active_only defaults to true (?active_only=false to see everything,
  // e.g. for a future admin view) — the common case for a guest-facing
  // menu list is "what can I actually order right now."
  const activeOnly = req.query.active_only !== 'false';

  try {
    const menus = await menuModel.findMenusByRestaurant(req.params.restaurantId, { activeOnly });
    res.json({ data: menus });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Restaurant not found' } });
    }
    logger.error(`GET /restaurants/:restaurantId/menus: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list menus' } });
  }
}

// ---------------------------------------------------------------------
// GET /meals/:id — meal details, with ingredients and addons.
//
// Three independent model calls run in parallel (Promise.all), not
// three sequential round-trips — the meal, its ingredients, and its
// addons don't depend on each other's results, so there's no reason to
// make the guest's request wait for them one after another. This is
// different from the N+1 concern in menuModel.js: three queries for ONE
// meal isn't N+1 (that's about one query PER ROW in a list), it's just
// "don't serialize independent work."
// ---------------------------------------------------------------------
export async function getMeal(req, res) {
  const { id } = req.params;

  try {
    const [meal, ingredients, addons] = await Promise.all([
      menuModel.findMealById(id),
      menuModel.findIngredientsByMealId(id),
      menuModel.findAddonsByMealId(id),
    ]);

    if (!meal) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Meal not found' } });
    }

    res.json({ ...meal, ingredients, addons });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Meal not found' } });
    }
    logger.error(`GET /meals/:id: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load meal' } });
  }
}

// ---------------------------------------------------------------------
// GET /restaurants/:restaurantId/menus/:menuId/meals — a menu's
// categories, each with its available meals nested. Public, same
// reasoning as listMenus/getMeal (view_menu has no ABAC condition).
// Fills a real, previously-flagged gap: meals could only be fetched one
// at a time by id, with no way to list what's actually on a menu.
// ---------------------------------------------------------------------
export async function listMenuMeals(req, res) {
  const { restaurantId, menuId } = req.params;
  // include_unavailable — the admin menu editor's only real use of this
  // public route (no permission gate: this isn't sensitive data, and
  // adding a whole parallel staff-only endpoint for one query param
  // would be more code for no real benefit).
  const includeUnavailable = req.query.include_unavailable === 'true';

  try {
    const menu = await menuModel.findMenuById(menuId, restaurantId);
    if (!menu) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Menu not found' } });
    }

    const categories = await menuModel.findCategoriesWithMealsByMenu(menuId, includeUnavailable);
    res.json({ id: menu.id, name: menu.name, description: menu.description, categories });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Menu not found' } });
    }
    logger.error(`GET /restaurants/:restaurantId/menus/:menuId/meals: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load menu' } });
  }
}

// ---------------------------------------------------------------------
// GET /restaurants/:restaurantId/recommendations — public, no auth
// (same reasoning as menu browsing: view_menu has no ABAC condition).
// See menuModel.findRecommendedMeals for the actual rule/ranking.
// ---------------------------------------------------------------------
export async function getRecommendations(req, res) {
  const { restaurantId } = req.params;
  const tags = typeof req.query.tags === 'string' ? req.query.tags.split(',').map((t) => t.trim()) : [];
  const limit = Math.min(20, Math.max(1, parseInt(req.query.limit, 10) || 10));

  try {
    const meals = await menuModel.findRecommendedMeals(restaurantId, tags, limit);
    res.json({ data: meals });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Restaurant not found' } });
    }
    logger.error(`GET /restaurants/:restaurantId/recommendations: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load recommendations' } });
  }
}

export const createMealSchema = z.object({
  category_id: z.string().min(1, 'required'),
  name: z.string().min(1, 'required'),
  base_price: z.number().positive('must be a positive number'),
  description: z.string().optional(),
  image_url: z.string().optional(),
  calories: z.number().optional(),
  protein_grams: z.number().optional(),
  carbs_grams: z.number().optional(),
  fat_grams: z.number().optional(),
  fiber_grams: z.number().optional(),
  sodium_mg: z.number().optional(),
  is_vegan: z.boolean().optional(),
  is_vegetarian: z.boolean().optional(),
  is_gluten_free: z.boolean().optional(),
  is_low_calorie: z.boolean().optional(),
  is_high_protein: z.boolean().optional(),
  is_available: z.boolean().optional(),
  estimated_prep_time_minutes: z.number().optional(),
});

// ---------------------------------------------------------------------
// POST /restaurants/:restaurantId/meals — behind edit_menu (manager/
// owner/system_admin). Previously not implemented at all: menu/meal data
// was seeded directly via SQL — a real, already-flagged gap, not a
// duplicate of anything. Body shape already validated by
// validate(createMealSchema) in routes/menus.js.
// ---------------------------------------------------------------------
export async function createMeal(req, res) {
  const { restaurantId } = req.params;
  const body = req.body;

  try {
    const category = await menuModel.findCategoryForRestaurant(body.category_id, restaurantId);
    if (!category) {
      return res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: 'category_id does not belong to a menu at this restaurant' },
      });
    }

    const meal = await menuModel.insertMeal({
      categoryId: body.category_id,
      restaurantId,
      name: body.name,
      description: body.description,
      imageUrl: body.image_url,
      basePrice: body.base_price,
      calories: body.calories,
      proteinGrams: body.protein_grams,
      carbsGrams: body.carbs_grams,
      fatGrams: body.fat_grams,
      fiberGrams: body.fiber_grams,
      sodiumMg: body.sodium_mg,
      isVegan: body.is_vegan,
      isVegetarian: body.is_vegetarian,
      isGlutenFree: body.is_gluten_free,
      isLowCalorie: body.is_low_calorie,
      isHighProtein: body.is_high_protein,
      isAvailable: body.is_available,
      estimatedPrepTimeMinutes: body.estimated_prep_time_minutes,
    });

    res.status(201).json(meal);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Invalid category_id' } });
    }
    logger.error(`POST /restaurants/:restaurantId/meals: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create meal' } });
  }
}

// ---------------------------------------------------------------------
// GET /meals/:id/ingredients — the same ingredient join as above, on its
// own. Genuinely redundant with the embedded list in getMeal() for a
// client that already fetched that — kept as its own endpoint because
// it was asked for directly, and it's a real, lighter-weight fetch for
// a UI that only needs an allergen/ingredient check without the rest of
// the meal payload.
// ---------------------------------------------------------------------
export async function getIngredients(req, res) {
  try {
    // Confirm the meal exists first — otherwise a bad :id and a real
    // meal with zero ingredients both just return `{ "data": [] }`,
    // which hides a genuine 404 as if it were a valid empty result.
    const exists = await menuModel.mealExists(req.params.id);
    if (!exists) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Meal not found' } });
    }

    const ingredients = await menuModel.findIngredientsByMealId(req.params.id);
    res.json({ data: ingredients });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Meal not found' } });
    }
    logger.error(`GET /meals/:id/ingredients: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load ingredients' } });
  }
}
