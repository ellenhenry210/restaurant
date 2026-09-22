import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { requirePlatformAdmin } from '../middleware/authorizePlatform.js';
import { authenticateGuest } from '../middleware/authGuest.js';
import { validate } from '../middleware/validate.js';
import * as suggestionController from '../controllers/suggestionController.js';

// feature_suggestions has no restaurant_id — it's a platform-wide,
// SnapOrder-level feature (the public roadmap), not scoped to one
// restaurant, so this is a standalone /v1/suggestions namespace rather
// than nested under /restaurants/:restaurantId.
const router = Router();

router.get('/suggestions', suggestionController.list);
router.post('/suggestions', authenticateGuest, validate(suggestionController.createSuggestionSchema), suggestionController.createByGuest);
router.post('/suggestions/:id/vote', authenticateGuest, suggestionController.voteAsGuest);
router.patch(
  '/suggestions/:id/roadmap-status',
  authenticate,
  requirePlatformAdmin('set_roadmap_status'),
  validate(suggestionController.setRoadmapStatusSchema),
  suggestionController.setRoadmapStatus
);

export default router;
