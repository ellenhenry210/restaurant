import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import * as reviewController from '../controllers/reviewController.js';

// mergeParams: true — mounted at /v1/restaurants/:restaurantId/reviews,
// needs :restaurantId from the parent mount (same pattern as staff.js).
const router = Router({ mergeParams: true });

router.post('/:reviewId/responses', authenticate, authorize('reply_to_review'), validate(reviewController.respondSchema), reviewController.respond);
router.patch('/:reviewId/moderate', authenticate, authorize('moderate_review'), validate(reviewController.moderateSchema), reviewController.moderate);

export default router;
