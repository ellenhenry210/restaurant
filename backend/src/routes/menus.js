import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import * as menuController from '../controllers/menuController.js';
import * as inventoryController from '../controllers/inventoryController.js';

// Routes/controllers/models split, migrated 2026-09-17 from the flat
// pattern. See controllers/menuController.js for request handling and
// models/menuModel.js for the actual queries.
const router = Router();

router.get('/restaurants/:restaurantId/menus', menuController.listMenus);
router.get('/restaurants/:restaurantId/menus/:menuId/meals', menuController.listMenuMeals);
router.get('/restaurants/:restaurantId/recommendations', menuController.getRecommendations);
router.get('/meals/:id', menuController.getMeal);
router.get('/meals/:id/ingredients', menuController.getIngredients);

// Staff-only write, unlike the three public reads above. restaurantIdParam
// defaults to 'restaurantId', which this path already has.
router.post(
  '/restaurants/:restaurantId/meals',
  authenticate,
  authorize('edit_menu'),
  validate(menuController.createMealSchema),
  menuController.createMeal
);

// mark_out_of_stock — kitchen_staff/manager/owner/system_admin, one
// tier below edit_menu, matching the matrix (kitchen staff can mark
// something sold out; only edit_menu roles can create/edit a meal).
router.patch(
  '/restaurants/:restaurantId/meals/:mealId/availability',
  authenticate,
  authorize('mark_out_of_stock'),
  validate(inventoryController.setAvailabilitySchema),
  inventoryController.setMealAvailability
);

export default router;
