import * as menuModel from '../models/menuModel.js';

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
    console.error('GET /restaurants/:restaurantId/menus: failed:', err.message);
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
    console.error('GET /meals/:id: failed:', err.message);
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

  try {
    const menu = await menuModel.findMenuById(menuId, restaurantId);
    if (!menu) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Menu not found' } });
    }

    const categories = await menuModel.findCategoriesWithMealsByMenu(menuId);
    res.json({ id: menu.id, name: menu.name, description: menu.description, categories });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Menu not found' } });
    }
    console.error('GET /restaurants/:restaurantId/menus/:menuId/meals: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load menu' } });
  }
}

function validateCreateMealInput(body) {
  const errors = [];
  if (!body.category_id || typeof body.category_id !== 'string') {
    errors.push({ field: 'category_id', reason: 'required' });
  }
  if (!body.name || typeof body.name !== 'string') {
    errors.push({ field: 'name', reason: 'required' });
  }
  if (typeof body.base_price !== 'number' || body.base_price <= 0) {
    errors.push({ field: 'base_price', reason: 'must be a positive number' });
  }
  return errors;
}

// ---------------------------------------------------------------------
// POST /restaurants/:restaurantId/meals — behind edit_menu (manager/
// owner/system_admin). Previously not implemented at all: menu/meal data
// was seeded directly via SQL — a real, already-flagged gap, not a
// duplicate of anything.
// ---------------------------------------------------------------------
export async function createMeal(req, res) {
  const errors = validateCreateMealInput(req.body ?? {});
  if (errors.length > 0) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: 'One or more fields are invalid', details: errors },
    });
  }

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
    console.error('POST /restaurants/:restaurantId/meals: failed:', err.message);
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
    console.error('GET /meals/:id/ingredients: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load ingredients' } });
  }
}
