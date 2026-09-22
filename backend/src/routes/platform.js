import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { requirePlatformAdmin } from '../middleware/authorizePlatform.js';
import * as analyticsController from '../controllers/analyticsController.js';

// Platform-level resources — System Admin only, not scoped to any one
// restaurant. First real route to use requirePlatformAdmin() outside a
// test (see middleware/authorizePlatform.js's doc comment — it was
// built and tested in isolation ahead of any route needing it).
const router = Router();

router.get('/analytics', authenticate, requirePlatformAdmin('view_platform_analytics'), analyticsController.getPlatformTotals);

export default router;
