import { z } from 'zod';

import * as billModel from '../models/billModel.js';
import { pool } from '../db.js';
import { logger } from '../logger.js';

const VALID_CALL_TRANSITIONS = {
  pending: ['acknowledged', 'resolved'],
  acknowledged: ['resolved'],
  resolved: [],
};

// Only checks "is this a real status at all" — same split as
// restaurantOrders.js's orderStatusSchema/itemStatusSchema: which
// transitions are legal from the CURRENT status needs a DB read first,
// so that stays a 409 check in the handler below, not something a
// schema can validate statically. This was the one write endpoint left
// on the old hand-rolled pattern after the rest of the codebase moved
// to validate() — found and closed in a 2026-09-22 hardening pass.
export const updateStatusSchema = z.object({
  status: z.enum(Object.keys(VALID_CALL_TRANSITIONS), {
    message: `status must be one of: ${Object.keys(VALID_CALL_TRANSITIONS).join(', ')}`,
  }),
});

// ---------------------------------------------------------------------
// GET /restaurants/:restaurantId/staff-calls?status=pending
// ---------------------------------------------------------------------
export async function list(req, res) {
  const { restaurantId } = req.params;
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;

  try {
    const calls = await billModel.findStaffCalls(restaurantId, statusFilter);
    res.json({ data: calls });
  } catch (err) {
    logger.error(`GET /restaurants/:restaurantId/staff-calls: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list staff calls' } });
  }
}

// ---------------------------------------------------------------------
// PATCH /restaurants/:restaurantId/staff-calls/:callId
//
// Moving to 'resolved' for a call tied to a pay_traditional bill also
// settles that bill — the staff-confirmed "I actually collected the
// payment" step. A call not tied to any bill (bill_id NULL — shouldn't
// currently happen since staff_calls are only created alongside a
// pay_traditional bill, but the column is nullable by design) just
// resolves on its own.
// ---------------------------------------------------------------------
export async function updateStatus(req, res) {
  const { restaurantId, callId } = req.params;
  const { status: nextStatus } = req.body;

  try {
    const current = await billModel.findStaffCallById(restaurantId, callId);
    if (!current) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Staff call not found' } });
    }

    const allowedNext = VALID_CALL_TRANSITIONS[current.status];
    if (!allowedNext.includes(nextStatus)) {
      return res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: `Cannot move a staff call from '${current.status}' to '${nextStatus}'. Valid next state(s): ${allowedNext.length ? allowedNext.join(', ') : 'none — this is a final state'}`,
        },
      });
    }

    const client = await pool.connect();
    let updated;
    try {
      await client.query('BEGIN');
      updated = await billModel.updateStaffCallStatus(callId, nextStatus, req.actor.id, client);

      if (nextStatus === 'resolved' && current.bill_id) {
        const bill = await billModel.findById(current.bill_id, client);
        if (bill && bill.timing === 'pay_traditional' && bill.status !== 'paid') {
          await client.query(
            `UPDATE bills SET status = 'settled_traditionally', settled_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [current.bill_id]
          );
          await billModel.finalizeGuestVisit(bill.sitting_id, bill.id, Number(bill.total_amount) + Number(bill.tip_amount), client);
        }
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.json(updated);
  } catch (err) {
    logger.error(`PATCH /restaurants/:restaurantId/staff-calls/:callId: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update staff call' } });
  }
}
