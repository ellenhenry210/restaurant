import { Router } from 'express';

import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import * as qrController from '../controllers/qrController.js';

// Standalone /v1/qr namespace, per explicit request, rather than nesting
// under /restaurants/:restaurantId/tables where routes/tables.js's other
// table-management endpoints live. :restaurantId is this router's own
// param (it isn't mounted under an existing /restaurants/:restaurantId
// prefix, so no mergeParams needed).
const router = Router();

router.get('/:restaurantId/:tableNumber', authenticate, authorize('manage_tables'), qrController.getTableQr);

export default router;
