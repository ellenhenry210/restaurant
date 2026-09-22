import { Router } from 'express';
import { z } from 'zod';

import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { emitOrderStatusUpdate, emitItemStatusUpdate } from '../realtime.js';
import { logger } from '../logger.js';

// mergeParams: true — mounted at /v1/restaurants/:restaurantId/orders,
// needs that :restaurantId in its own req.params (see routes/staff.js
// for the same pattern).
const router = Router({ mergeParams: true });

// State machines — an order/item can't jump from any status to any
// other. This is the state-based ABAC condition from SNAPORDER_
// AUTHORIZATION.md Part 2 #5 made concrete: "kitchen accepts an order
// only if placed/confirmed" etc. generalizes to "every transition has
// to be a real, listed one." served and cancelled are terminal — no
// entry has an empty-but-present set for them by accident, they
// genuinely allow nothing further.
const VALID_ORDER_TRANSITIONS = {
  placed: ['confirmed', 'cancelled'],
  confirmed: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served'],
  served: [],
  cancelled: [],
};

const ORDER_TIMESTAMP_COLUMN = {
  confirmed: 'confirmed_at',
  ready: 'ready_at',
  served: 'served_at',
  cancelled: 'cancelled_at',
};

const VALID_ITEM_TRANSITIONS = {
  pending: ['preparing', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['served'],
  served: [],
  cancelled: [],
};

// Only checks "is this a real status at all" — the state-machine rule
// (which transitions from the CURRENT status are legal) needs a DB read
// first, so it stays a 409 check in the handler, not something a schema
// can validate statically.
const orderStatusSchema = z.object({
  status: z.enum(Object.keys(VALID_ORDER_TRANSITIONS), {
    message: `status must be one of: ${Object.keys(VALID_ORDER_TRANSITIONS).join(', ')}`,
  }),
});

const itemStatusSchema = z.object({
  status: z.enum(Object.keys(VALID_ITEM_TRANSITIONS), {
    message: `status must be one of: ${Object.keys(VALID_ITEM_TRANSITIONS).join(', ')}`,
  }),
});

// ---------------------------------------------------------------------
// GET / — list a restaurant's orders. view_all_orders covers waiter,
// kitchen_staff, manager, owner, system_admin per the matrix — a
// superset of view_kitchen_queue (kitchen_staff/manager/owner/admin
// only). Not enforced as a separate permission: a kitchen-focused UI
// gets the same data via ?status=placed,confirmed,preparing rather than
// a dedicated endpoint checking a narrower permission — a deliberate
// simplification, not an oversight, since the two would return
// identical rows for anyone who actually has view_kitchen_queue.
// ---------------------------------------------------------------------
router.get('/', authenticate, authorize('view_all_orders'), async (req, res) => {
  const { restaurantId } = req.params;
  const statusFilter = req.query.status ? req.query.status.split(',') : null;

  try {
    const result = await pool.query(
      `SELECT o.id, o.table_id, t.table_number, o.order_number, o.status,
              o.placed_at, o.confirmed_at, o.ready_at, o.served_at, o.cancelled_at,
              o.subtotal, o.tax, o.service_charge, o.total_amount, o.tip_amount,
              o.special_requests, o.allergen_warnings
       FROM orders o
       JOIN tables t ON t.id = o.table_id
       WHERE o.restaurant_id = $1
         AND ($2::text[] IS NULL OR o.status = ANY($2::text[]))
       ORDER BY o.placed_at ASC`,
      [restaurantId, statusFilter]
    );
    res.json({ data: result.rows });
  } catch (err) {
    logger.error(`GET /restaurants/:restaurantId/orders: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list orders' } });
  }
});

// ---------------------------------------------------------------------
// GET /:orderId — one order's full detail, items included. Missing
// until now: the KDS/staff order views had a list (order-level fields
// only) and could change an item's status, but nothing to actually see
// which items an in-progress order has when the page first loads (the
// realtime new_order event carries items, but only for orders placed
// AFTER the page connected — a kitchen display that's opened once per
// shift needs this for whatever's already in flight).
// ---------------------------------------------------------------------
router.get('/:orderId', authenticate, authorize('view_all_orders'), async (req, res) => {
  const { restaurantId, orderId } = req.params;

  try {
    const orderResult = await pool.query(
      `SELECT o.id, o.table_id, t.table_number, o.order_number, o.status,
              o.placed_at, o.confirmed_at, o.ready_at, o.served_at, o.cancelled_at,
              o.subtotal, o.tax, o.service_charge, o.total_amount, o.tip_amount,
              o.special_requests, o.allergen_warnings
       FROM orders o
       JOIN tables t ON t.id = o.table_id
       WHERE o.id = $1 AND o.restaurant_id = $2`,
      [orderId, restaurantId]
    );
    const order = orderResult.rows[0];
    if (!order) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }

    const itemsResult = await pool.query(
      `SELECT id, meal_id, meal_name, meal_price, quantity, status, special_request,
              removed_ingredients, allergen_caution_acknowledged, added_addons
       FROM order_items
       WHERE order_id = $1
       ORDER BY created_at ASC`,
      [orderId]
    );

    res.json({ ...order, items: itemsResult.rows });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    logger.error(`GET /restaurants/:restaurantId/orders/:orderId: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load order' } });
  }
});

// ---------------------------------------------------------------------
// PATCH /:orderId/status — advance (or cancel) an order.
//
// Uses authorize('modify_order') for the whole endpoint, including
// cancellations, rather than switching to authorize('cancel_order')
// when status === 'cancelled'. Today that's exactly correct: both
// permissions grant the identical staff role set (waiter/manager/
// owner/system_admin — kitchen_staff has neither). If the matrix ever
// gives one permission a role the other doesn't, this coupling needs
// to be revisited — noted here so that divergence doesn't silently
// become a bug.
// ---------------------------------------------------------------------
router.patch('/:orderId/status', authenticate, authorize('modify_order'), validate(orderStatusSchema), async (req, res) => {
  const { restaurantId, orderId } = req.params;
  const { status: nextStatus } = req.body;

  try {
    const currentResult = await pool.query(
      `SELECT status, table_id FROM orders WHERE id = $1 AND restaurant_id = $2`,
      [orderId, restaurantId]
    );
    const current = currentResult.rows[0];
    if (!current) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }

    const allowedNext = VALID_ORDER_TRANSITIONS[current.status];
    if (!allowedNext.includes(nextStatus)) {
      return res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: `Cannot move an order from '${current.status}' to '${nextStatus}'. Valid next state(s): ${allowedNext.length ? allowedNext.join(', ') : 'none — this is a final state'}`,
        },
      });
    }

    const timestampColumn = ORDER_TIMESTAMP_COLUMN[nextStatus];
    const result = await pool.query(
      timestampColumn
        ? `UPDATE orders SET status = $1, ${timestampColumn} = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, status, ${timestampColumn}`
        : `UPDATE orders SET status = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, status`,
      [nextStatus, orderId]
    );

    const updated = result.rows[0];

    // Broadcast-only — see realtime.js's top comment. This never changes
    // what the HTTP response says; a failure here is logged, not surfaced
    // as a failed status update (the update itself already succeeded).
    try {
      emitOrderStatusUpdate(restaurantId, current.table_id, { order_id: updated.id, status: updated.status });
    } catch (err) {
      logger.error(`emitOrderStatusUpdate failed (status update itself still succeeded): ${err.message}`);
    }

    res.json(updated);
  } catch (err) {
    logger.error(`PATCH /restaurants/:restaurantId/orders/:orderId/status: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update order status' } });
  }
});

// ---------------------------------------------------------------------
// PATCH /:orderId/items/:itemId/status — kitchen updating one item.
// update_kitchen_item_status genuinely differs from modify_order in the
// matrix (kitchen_staff has it, waiter doesn't — the reverse of the
// order-level endpoint above), so this is its own real authorize() call,
// not sharing the one above.
// ---------------------------------------------------------------------
router.patch(
  '/:orderId/items/:itemId/status',
  authenticate,
  authorize('update_kitchen_item_status'),
  validate(itemStatusSchema),
  async (req, res) => {
    const { restaurantId, orderId, itemId } = req.params;
    const { status: nextStatus } = req.body;

    try {
      // Join through orders to confirm the item actually belongs to a
      // real order at THIS restaurant — an item's own row has no
      // restaurant_id to check directly. table_id comes along too, for
      // the realtime broadcast below (order_items has no table_id of
      // its own either).
      const currentResult = await pool.query(
        `SELECT oi.status, o.table_id
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE oi.id = $1 AND oi.order_id = $2 AND o.restaurant_id = $3`,
        [itemId, orderId, restaurantId]
      );
      const current = currentResult.rows[0];
      if (!current) {
        return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order item not found' } });
      }

      const allowedNext = VALID_ITEM_TRANSITIONS[current.status];
      if (!allowedNext.includes(nextStatus)) {
        return res.status(409).json({
          error: {
            code: 'CONFLICT',
            message: `Cannot move an item from '${current.status}' to '${nextStatus}'. Valid next state(s): ${allowedNext.length ? allowedNext.join(', ') : 'none — this is a final state'}`,
          },
        });
      }

      // Records who on the kitchen team actually handled this item —
      // req.actor is the caller's own restaurant_staff row, attached by
      // authorize() on success.
      const result = await pool.query(
        `UPDATE order_items
         SET status = $1, prepared_by_staff_id = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $3
         RETURNING id, status, prepared_by_staff_id`,
        [nextStatus, req.actor.id, itemId]
      );

      const updated = result.rows[0];

      try {
        emitItemStatusUpdate(restaurantId, current.table_id, { order_id: orderId, item_id: updated.id, status: updated.status });
      } catch (err) {
        logger.error(`emitItemStatusUpdate failed (status update itself still succeeded): ${err.message}`);
      }

      res.json(updated);
    } catch (err) {
      logger.error(`PATCH .../items/:itemId/status: failed: ${err.message}`);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update item status' } });
    }
  }
);

export default router;
