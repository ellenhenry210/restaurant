import * as billModel from '../models/billModel.js';
import { pool } from '../db.js';

const VALID_CALL_TRANSITIONS = {
  pending: ['acknowledged', 'resolved'],
  acknowledged: ['resolved'],
  resolved: [],
};

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
    console.error('GET /restaurants/:restaurantId/staff-calls: failed:', err.message);
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
  const { status: nextStatus } = req.body ?? {};

  if (typeof nextStatus !== 'string' || !(nextStatus in VALID_CALL_TRANSITIONS)) {
    return res.status(400).json({
      error: { code: 'INVALID_REQUEST', message: `status must be one of: ${Object.keys(VALID_CALL_TRANSITIONS).join(', ')}` },
    });
  }

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
    console.error('PATCH /restaurants/:restaurantId/staff-calls/:callId: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update staff call' } });
  }
}
