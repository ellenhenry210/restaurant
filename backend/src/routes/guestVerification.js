import { Router } from 'express';

import { authenticateGuest } from '../middleware/authGuest.js';
import { validate } from '../middleware/validate.js';
import * as guestVerificationController from '../controllers/guestVerificationController.js';

// Guest phone verification — see migration 020's doc comment for scope
// (the mechanism only; not yet required by any other flow).
const router = Router();

router.post(
  '/guest/verify-phone/request',
  authenticateGuest,
  validate(guestVerificationController.requestOtpSchema),
  guestVerificationController.requestOtp
);
router.post(
  '/guest/verify-phone/confirm',
  authenticateGuest,
  validate(guestVerificationController.confirmOtpSchema),
  guestVerificationController.confirmOtp
);

export default router;
