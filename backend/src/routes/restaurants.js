import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import * as restaurantController from '../controllers/restaurantController.js';
import * as analyticsController from '../controllers/analyticsController.js';

// Routes/controllers/models split, migrated 2026-09-17 from the flat
// pattern (this file used to query the database directly). See
// controllers/restaurantController.js for request handling and
// models/restaurantModel.js for the actual queries — this file is just
// the URL-to-handler wiring.
const router = Router();

router.get('/', restaurantController.list);
router.get('/:id', restaurantController.getOne);

// Staff-only, unlike the two public routes above. restaurantIdParam: 'id'
// — this router's param is :id, not the :restaurantId authorize()
// defaults to (that default matches routes mounted with mergeParams
// under an existing /restaurants/:restaurantId prefix, which this one
// isn't).
router.get(
  '/:id/analytics/daily',
  authenticate,
  authorize('view_restaurant_analytics', { restaurantIdParam: 'id' }),
  analyticsController.getDaily
);

export default router;
