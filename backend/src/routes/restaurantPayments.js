import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import * as restaurantBillController from '../controllers/restaurantBillController.js';

// mergeParams: true — mounted at /v1/restaurants/:restaurantId/payments.
const router = Router({ mergeParams: true });

router.get('/', authenticate, authorize('view_payment_history'), restaurantBillController.listPayments);

export default router;
