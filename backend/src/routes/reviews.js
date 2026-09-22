import { Router } from 'express';

import { authenticateGuest } from '../middleware/authGuest.js';
import { validate } from '../middleware/validate.js';
import * as reviewController from '../controllers/reviewController.js';

// Guest-facing + the one public read. Mounted at /v1 (like guestSession.js
// / bills.js) since paths vary between /orders/..., /reviews/..., and
// /restaurants/:restaurantId/reviews. Staff-only actions (reply/moderate)
// live in routes/restaurantReviews.js instead, mounted under a
// restaurant-scoped prefix so authorize() has the :restaurantId it needs.
const router = Router();

router.post('/orders/:orderId/reviews', authenticateGuest, validate(reviewController.leaveReviewSchema), reviewController.create);
router.patch('/reviews/:reviewId', authenticateGuest, validate(reviewController.editReviewSchema), reviewController.update);
router.get('/restaurants/:restaurantId/reviews', reviewController.listPublic);

export default router;
