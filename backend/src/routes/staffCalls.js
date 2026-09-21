import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import * as staffCallController from '../controllers/staffCallController.js';

// mergeParams: true — mounted at /v1/restaurants/:restaurantId/staff-calls,
// needs that :restaurantId in its own req.params (same pattern as
// restaurantOrders.js/staff.js). process_payment is the same permission
// that already gates handling a guest's payment, so "come collect a
// pay_traditional bill" is scoped to the same role set (waiter/manager/
// owner/system_admin) rather than inventing a new permission for it.
const router = Router({ mergeParams: true });

router.get('/', authenticate, authorize('process_payment'), staffCallController.list);
router.patch('/:callId', authenticate, authorize('process_payment'), staffCallController.updateStatus);

export default router;
