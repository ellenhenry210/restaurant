import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { requireActiveStaff } from '../middleware/requireActiveStaff.js';
import { validate } from '../middleware/validate.js';
import * as suggestionController from '../controllers/suggestionController.js';

// mergeParams: true — mounted at /v1/restaurants/:restaurantId/suggestions.
// The :restaurantId here is only used to prove the caller is an active
// staff member somewhere (authorize()'s ownership check) — the created
// suggestion/vote itself is still platform-wide, not restaurant-scoped
// (feature_suggestions has no restaurant_id column).
const router = Router({ mergeParams: true });

// No specific permission gate — see suggestionController.createByStaff's
// doc comment for why (none is defined for creation in the matrix).
router.post('/', authenticate, requireActiveStaff(), validate(suggestionController.createSuggestionSchema), suggestionController.createByStaff);
router.post('/:id/vote', authenticate, authorize('vote_suggestion'), suggestionController.voteAsStaff);

export default router;
