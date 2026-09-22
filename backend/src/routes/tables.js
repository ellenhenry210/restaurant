import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { logger } from '../logger.js';

// mergeParams: true — mounted at /v1/restaurants/:restaurantId/tables,
// needs :restaurantId from the parent mount (same pattern as staff.js).
const router = Router({ mergeParams: true });

const assignTableSchema = z.object({
  staff_id: z.string().min(1, 'staff_id is required'),
});

// ---------------------------------------------------------------------
// POST /:tableId/assign — assign a staff member to serve a table. See
// routes/guestSession.js and routes/orders.js for where this becomes
// visible to the guest ("Your server: Wendy").
//
// Reassigning an already-assigned table ends the previous assignment
// and starts a new one, atomically, rather than requiring a separate
// unassign call first — a manager moving tables between servers
// mid-shift is a single action from their point of view, not two.
// ---------------------------------------------------------------------
router.post('/:tableId/assign', authenticate, authorize('assign_table'), validate(assignTableSchema), async (req, res) => {
  const { restaurantId, tableId } = req.params;
  const { staff_id: staffId } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The table must actually belong to this restaurant.
    const tableResult = await client.query('SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2', [tableId, restaurantId]);
    if (!tableResult.rows[0]) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Table not found' } });
    }

    // The staff member must actually be active staff at this SAME
    // restaurant — assigning someone else's waiter to your table isn't
    // a thing, even if they happen to know the user_id.
    const staffResult = await client.query(
      `SELECT id, name, display_name, role FROM restaurant_staff WHERE id = $1 AND restaurant_id = $2 AND is_active = TRUE`,
      [staffId, restaurantId]
    );
    const staff = staffResult.rows[0];
    if (!staff) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'staff_id is not active staff at this restaurant' } });
    }

    // End any current assignment before starting the new one — this is
    // what makes reassignment a single call (see comment above) and
    // what keeps unique_active_assignment_per_table satisfied.
    await client.query(
      `UPDATE table_assignments SET unassigned_at = CURRENT_TIMESTAMP WHERE table_id = $1 AND unassigned_at IS NULL`,
      [tableId]
    );

    const result = await client.query(
      `INSERT INTO table_assignments (table_id, staff_id) VALUES ($1, $2) RETURNING id, assigned_at`,
      [tableId, staffId]
    );

    await client.query('COMMIT');

    res.status(201).json({
      id: result.rows[0].id,
      table_id: tableId,
      assigned_at: result.rows[0].assigned_at,
      staff: { id: staff.id, name: staff.display_name ?? staff.name, role: staff.role },
    });
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error(`POST /tables/:tableId/assign: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to assign table' } });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// POST /:tableId/unassign — end the current assignment, if any. Not an
// error if there wasn't one — "make sure nobody's assigned" is a
// reasonable thing to call even if that was already true.
// ---------------------------------------------------------------------
router.post('/:tableId/unassign', authenticate, authorize('assign_table'), async (req, res) => {
  const { restaurantId, tableId } = req.params;

  try {
    const tableResult = await pool.query('SELECT id FROM tables WHERE id = $1 AND restaurant_id = $2', [tableId, restaurantId]);
    if (!tableResult.rows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Table not found' } });
    }

    const result = await pool.query(
      `UPDATE table_assignments SET unassigned_at = CURRENT_TIMESTAMP
       WHERE table_id = $1 AND unassigned_at IS NULL
       RETURNING id`,
      [tableId]
    );

    res.json({ table_id: tableId, was_assigned: result.rows.length > 0 });
  } catch (err) {
    logger.error(`POST /tables/:tableId/unassign: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to unassign table' } });
  }
});

export default router;
