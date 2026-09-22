import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import * as inventoryController from '../controllers/inventoryController.js';

// mergeParams: true — mounted at /v1/restaurants/:restaurantId/ingredients.
const router = Router({ mergeParams: true });

router.get('/', authenticate, authorize('view_inventory'), inventoryController.listIngredients);
router.patch(
  '/:ingredientId/stock',
  authenticate,
  authorize('set_inventory_levels'),
  validate(inventoryController.setStockSchema),
  inventoryController.setIngredientStock
);

export default router;
