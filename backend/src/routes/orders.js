import { Router } from 'express';

import { authenticateGuest } from '../middleware/authGuest.js';
import { validate } from '../middleware/validate.js';
import * as orderController from '../controllers/orderController.js';
import * as paymentController from '../controllers/paymentController.js';

// Routes/controllers/models split, migrated 2026-09-17 from the flat
// pattern. See controllers/orderController.js for the transaction
// orchestration + allergen-policy business logic, and
// models/orderModel.js for the actual queries.
const router = Router();

router.post('/', authenticateGuest, validate(orderController.createOrderSchema), orderController.create);
router.get('/:id', authenticateGuest, orderController.getStatus);
router.patch('/:id/cancel', authenticateGuest, orderController.cancel);

// Payment on an order the guest already placed — same ownership model as
// GET /:id above (table-based, via req.guestSession), not a separate
// "payments" resource of its own. See controllers/paymentController.js.
router.post('/:id/payments/initialize', authenticateGuest, paymentController.initialize);

export default router;
