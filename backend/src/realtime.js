import { Server } from 'socket.io';

import { verifyToken } from './auth.js';
import { pool } from './db.js';
import { roleGrants } from './authorization/permissions.js';
import { logger } from './logger.js';

// Module-level singleton, same pattern as db.js's `pool` — one Socket.io
// server for the whole process, initialized once at startup (initRealtime,
// called from index.js) and imported wherever it's needed (the order
// controllers, to broadcast after a write succeeds) via getIo().
let io = null;

/**
 * Design choice worth being explicit about: this is a BROADCAST-ONLY
 * socket layer. The only way to actually change an order's or an item's
 * status is still the existing REST PATCH endpoints
 * (routes/restaurantOrders.js) — already transactional, state-machine
 * validated, and permission-checked. Sockets exist purely to notify
 * connected clients after one of those writes succeeds; they are not a
 * second path to the same state changes. Rebuilding that validation
 * logic a second time as socket message handlers (which an earlier,
 * pre-Socket.io draft of the KDS protocol in SNAPORDER_API_CONTRACTS.md
 * sketched as client -> server messages) would mean two places that can
 * disagree about what transitions are legal — the exact drift risk
 * already flagged elsewhere in this codebase for the models/controllers
 * split. Updated that doc section to match this reality.
 *
 * @param {import('node:http').Server} httpServer
 * @returns {Server}
 */
export function initRealtime(httpServer) {
  io = new Server(httpServer);
  io.on('connection', (socket) => handleConnection(socket));
  return io;
}

/** @returns {Server} the initialized Socket.io server. */
export function getIo() {
  if (!io) {
    throw new Error('getIo() called before initRealtime() — realtime layer is not set up yet.');
  }
  return io;
}

/**
 * Authenticates a new connection using the same JWTs as the HTTP API
 * (socket.handshake.auth.token), then either:
 * - a guest token: joins `table:{tableId}` immediately — a guest only
 *   ever needs updates about their own table, known from their session.
 * - a staff token: confirms the account still exists, then waits for a
 *   `join_kitchen` event naming which restaurant to watch (a JWT alone
 *   doesn't carry role/restaurant, same reasoning as middleware/
 *   authorize.js — that's resolved fresh, not trusted from the token).
 */
async function handleConnection(socket) {
  const token = socket.handshake.auth?.token;
  if (!token) {
    socket.emit('error', { message: 'Missing auth token' });
    return socket.disconnect(true);
  }

  let payload;
  try {
    payload = verifyToken(token);
  } catch {
    socket.emit('error', { message: 'Invalid or expired token' });
    return socket.disconnect(true);
  }

  if (payload.type === 'guest') {
    try {
      const result = await pool.query(
        'SELECT id, table_id, restaurant_id, expires_at FROM guest_sessions WHERE id = $1',
        [payload.sub]
      );
      const session = result.rows[0];
      if (!session || new Date(session.expires_at).getTime() <= Date.now()) {
        socket.emit('error', { message: 'Session no longer valid' });
        return socket.disconnect(true);
      }
      socket.data.identity = { type: 'guest', tableId: session.table_id, restaurantId: session.restaurant_id };
      socket.join(`table:${session.table_id}`);
      socket.emit('connected', { role: 'guest', table_id: session.table_id });
    } catch (err) {
      logger.error(`realtime: guest connection failed: ${err.message}`);
      socket.disconnect(true);
    }
    return;
  }

  // Staff token.
  try {
    const userResult = await pool.query('SELECT id FROM users WHERE id = $1', [payload.sub]);
    if (!userResult.rows[0]) {
      socket.emit('error', { message: 'Account no longer exists' });
      return socket.disconnect(true);
    }
    socket.data.identity = { type: 'staff', userId: payload.sub };
    socket.emit('connected', { role: 'staff' });
  } catch (err) {
    logger.error(`realtime: staff connection failed: ${err.message}`);
    return socket.disconnect(true);
  }

  // Front-of-house staff generally (not kitchen-specific) — joined the
  // same way as join_kitchen, but gated on process_payment rather than
  // view_all_orders, since this room is specifically where a
  // Pay-Traditionally "call the waiter" event lands.
  socket.on('join_staff', async (data, ack) => {
    const restaurantId = data?.restaurantId;
    if (!restaurantId) {
      return ack?.({ ok: false, error: 'restaurantId is required' });
    }

    try {
      const staffResult = await pool.query(
        'SELECT role, is_active FROM restaurant_staff WHERE user_id = $1 AND restaurant_id = $2',
        [socket.data.identity.userId, restaurantId]
      );
      const staff = staffResult.rows[0];

      if (!staff) {
        return ack?.({ ok: false, error: 'You have no role at this restaurant' });
      }
      if (!staff.is_active) {
        return ack?.({ ok: false, error: 'Your access to this restaurant has been deactivated' });
      }
      if (!roleGrants(staff.role, 'process_payment')) {
        return ack?.({ ok: false, error: `Role '${staff.role}' cannot 'process_payment'` });
      }

      socket.join(`staff:${restaurantId}`);
      ack?.({ ok: true, restaurant_id: restaurantId });
    } catch (err) {
      logger.error(`realtime: join_staff failed: ${err.message}`);
      ack?.({ ok: false, error: 'Failed to join' });
    }
  });

  socket.on('join_kitchen', async (data, ack) => {
    const restaurantId = data?.restaurantId;
    if (!restaurantId) {
      return ack?.({ ok: false, error: 'restaurantId is required' });
    }

    try {
      const staffResult = await pool.query(
        'SELECT role, is_active FROM restaurant_staff WHERE user_id = $1 AND restaurant_id = $2',
        [socket.data.identity.userId, restaurantId]
      );
      const staff = staffResult.rows[0];

      if (!staff) {
        return ack?.({ ok: false, error: 'You have no role at this restaurant' });
      }
      if (!staff.is_active) {
        return ack?.({ ok: false, error: 'Your access to this restaurant has been deactivated' });
      }
      if (!roleGrants(staff.role, 'view_all_orders')) {
        return ack?.({ ok: false, error: `Role '${staff.role}' cannot 'view_all_orders'` });
      }

      socket.join(`kitchen:${restaurantId}`);
      ack?.({ ok: true, restaurant_id: restaurantId });
    } catch (err) {
      logger.error(`realtime: join_kitchen failed: ${err.message}`);
      ack?.({ ok: false, error: 'Failed to join' });
    }
  });
}

// --- Emission helpers — called from controllers after a write commits ---

/** A new order was placed — kitchen-side only; the guest already has it via the REST response. */
export function emitNewOrder(restaurantId, order) {
  getIo().to(`kitchen:${restaurantId}`).emit('new_order', order);
}

/** An order's overall status changed — both the kitchen (other staff) and the guest at that table care. */
export function emitOrderStatusUpdate(restaurantId, tableId, data) {
  getIo().to(`kitchen:${restaurantId}`).to(`table:${tableId}`).emit('order_status_updated', data);
}

/** One item's status changed — same audience as above. */
export function emitItemStatusUpdate(restaurantId, tableId, data) {
  getIo().to(`kitchen:${restaurantId}`).to(`table:${tableId}`).emit('item_status_updated', data);
}

/** A guest chose Pay Traditionally — front-of-house staff need to go collect payment in person. */
export function emitWaiterCalled(restaurantId, data) {
  getIo().to(`staff:${restaurantId}`).emit('waiter_called', data);
}
