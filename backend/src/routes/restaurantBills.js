import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import * as restaurantBillController from '../controllers/restaurantBillController.js';

// mergeParams: true — mounted at /v1/restaurants/:restaurantId/bills.
const router = Router({ mergeParams: true });

router.post('/:billId/refund', authenticate, authorize('issue_refund'), restaurantBillController.refund);

export default router;
