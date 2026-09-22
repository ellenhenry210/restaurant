import { z } from 'zod';

import * as inventoryModel from '../models/inventoryModel.js';
import { logAudit } from '../audit.js';
import { logger } from '../logger.js';

export const setAvailabilitySchema = z.object({
  is_available: z.boolean(),
});

export const setStockSchema = z
  .object({
    current_stock: z.number().int().nonnegative('must be zero or a positive integer').optional(),
    reorder_level: z.number().int().nonnegative('must be zero or a positive integer').optional(),
    is_active: z.boolean().optional(),
  })
  .refine((data) => data.current_stock !== undefined || data.reorder_level !== undefined || data.is_active !== undefined, {
    message: 'at least one of current_stock, reorder_level, is_active is required',
  });

// ---------------------------------------------------------------------
// PATCH /restaurants/:restaurantId/meals/:mealId/availability —
// mark_out_of_stock. The guest-visible "sold out" toggle — a real,
// previously-flagged gap: a meal could only be marked unavailable by
// hand-editing the database.
// ---------------------------------------------------------------------
export async function setMealAvailability(req, res) {
  const { restaurantId, mealId } = req.params;
  const { is_available: isAvailable } = req.body;

  try {
    const meal = await inventoryModel.findMealForRestaurant(mealId, restaurantId);
    if (!meal) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Meal not found' } });
    }
    const updated = await inventoryModel.setMealAvailability(mealId, isAvailable);

    // Worth its own audit entry regardless of outcome, same reasoning as
    // authorize()'s denials — "this meal went unavailable" is the kind
    // of change a manager investigating a bad night wants a record of.
    await logAudit({
      restaurantId,
      action: 'inventory_updated',
      actorType: 'staff',
      actorId: req.actor.id,
      resourceType: 'meal',
      resourceId: mealId,
      changes: { is_available: isAvailable },
      ipAddress: req.ip,
    });

    res.json(updated);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Meal not found' } });
    }
    logger.error(`PATCH /restaurants/:restaurantId/meals/:mealId/availability: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update meal availability' } });
  }
}

// ---------------------------------------------------------------------
// GET /restaurants/:restaurantId/ingredients — view_inventory.
// ---------------------------------------------------------------------
export async function listIngredients(req, res) {
  const { restaurantId } = req.params;
  try {
    const ingredients = await inventoryModel.findIngredientsByRestaurant(restaurantId);
    res.json({ data: ingredients });
  } catch (err) {
    logger.error(`GET /restaurants/:restaurantId/ingredients: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list ingredients' } });
  }
}

// ---------------------------------------------------------------------
// PATCH /restaurants/:restaurantId/ingredients/:ingredientId/stock —
// set_inventory_levels (manager/owner/system_admin — one tier above
// mark_out_of_stock, matching the matrix).
// ---------------------------------------------------------------------
export async function setIngredientStock(req, res) {
  const { restaurantId, ingredientId } = req.params;
  const { current_stock: currentStock, reorder_level: reorderLevel, is_active: isActive } = req.body;

  try {
    const ingredient = await inventoryModel.findIngredientForRestaurant(ingredientId, restaurantId);
    if (!ingredient) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ingredient not found' } });
    }
    const updated = await inventoryModel.setIngredientStock(ingredientId, { currentStock, reorderLevel, isActive });

    await logAudit({
      restaurantId,
      action: 'inventory_updated',
      actorType: 'staff',
      actorId: req.actor.id,
      resourceType: 'ingredient',
      resourceId: ingredientId,
      changes: { current_stock: currentStock, reorder_level: reorderLevel, is_active: isActive },
      ipAddress: req.ip,
    });

    res.json(updated);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ingredient not found' } });
    }
    logger.error(`PATCH /restaurants/:restaurantId/ingredients/:ingredientId/stock: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update ingredient stock' } });
  }
}
