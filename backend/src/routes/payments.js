import { Router } from 'express';
import express from 'express';

import * as paymentController from '../controllers/paymentController.js';

// Public — Paystack calls this directly, with no guest/staff session.
// express.raw() here (not the app-wide express.json()) preserves the
// exact byte body the HMAC signature was computed over. Must be mounted
// in index.js BEFORE app.use(express.json()) — see that file's comment.
const router = Router();

router.post('/webhook', express.raw({ type: 'application/json' }), paymentController.handleWebhook);

export default router;
