import { Router } from 'express';

import { authenticateGuest } from '../middleware/authGuest.js';
import * as billController from '../controllers/billController.js';

// All guest-facing — see SNAPORDER_API_CONTRACTS.md's "Bills & Payment
// Timing" section. Mounted at /v1 (like guestSession.js) rather than
// nested under a resource prefix, since paths vary between
// /guest/session/bill... and /bills/....
const router = Router();

router.post('/guest/session/bill', authenticateGuest, billController.create);
router.get('/guest/session/bill/:billId', authenticateGuest, billController.getOne);

router.post('/bills/:billId/request-split', authenticateGuest, billController.requestSplit);
router.get('/bills/:billId/splits', authenticateGuest, billController.getSplits);
router.post('/bills/:billId/payments/initialize', authenticateGuest, billController.initializeBillPayment);
router.post('/bills/splits/:shareId/payments/initialize', authenticateGuest, billController.initializeSharePayment);

export default router;
