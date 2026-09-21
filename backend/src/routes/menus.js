import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import * as menuController from '../controllers/menuController.js';

// Routes/controllers/models split, migrated 2026-09-17 from the flat
// pattern. See controllers/menuController.js for request handling and
// models/menuModel.js for the actual queries.
const router = Router();

router.get('/restaurants/:restaurantId/menus', menuController.listMenus);
router.get('/restaurants/:restaurantId/menus/:menuId/meals', menuController.listMenuMeals);
router.get('/meals/:id', menuController.getMeal);
router.get('/meals/:id/ingredients', menuController.getIngredients);

// Staff-only write, unlike the three public reads above. restaurantIdParam
// defaults to 'restaurantId', which this path already has.
router.post('/restaurants/:restaurantId/meals', authenticate, authorize('edit_menu'), menuController.createMeal);

export default router;
