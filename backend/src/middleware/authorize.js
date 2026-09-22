import { pool } from '../db.js';
import { roleGrants } from '../authorization/permissions.js';
import { logAudit } from '../audit.js';
import { logger } from '../logger.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Express middleware factory implementing SNAPORDER_AUTHORIZATION.md
 * Part 4's enforcement pattern for real:
 *
 *   CAN_ACCESS = (RBAC role grants the permission) AND (ABAC conditions met)
 *
 * Must run AFTER authenticate() — it reads req.user, which authenticate()
 * sets. Usage:
 *
 *   app.get(
 *     '/v1/restaurants/:restaurantId/staff',
 *     authenticate,
 *     authorize('view_staff'),
 *     handler
 *   );
 *
 * With an extra ABAC condition (beyond the built-in restaurant-ownership
 * check, which every call gets automatically — see below):
 *
 *   authorize('cancel_order', {
 *     abac: (staff, req) => req.order.status !== 'preparing',
 *   })
 *
 * ## What this checks, in order (stops at the first failure)
 *
 * 1. **Identity resolved to a role at THIS restaurant** — looks up
 *    restaurant_staff WHERE user_id = req.user.id AND restaurant_id =
 *    req.params[restaurantIdParam] (default param name: 'restaurantId').
 *    This one lookup *is* the data-ownership ABAC condition (Part 2 #1):
 *    it's structurally impossible to pass this check for a restaurant
 *    you're not staff at, since the query simply returns no row.
 * 2. **Still active** — restaurant_staff.is_active, checked fresh on
 *    every call. This is what makes deprovisioning take effect
 *    immediately rather than only once a token expires (Part 0) — the
 *    piece authenticate() alone couldn't cover, since it has no
 *    restaurant context to check is_active against.
 * 3. **Role grants the permission** — roleGrants() against the matrix in
 *    ../authorization/permissions.js.
 * 4. **Any extra ABAC condition passed via options.abac** — for anything
 *    beyond ownership: time-based, state-based, session/shift context
 *    (Part 2 #2-5). Receives (staffRow, req) and may be async.
 *
 * On success, req.actor is set to the restaurant_staff row ({ id,
 * restaurant_id, role, is_active, name }) for the handler to use.
 *
 * ## Audit logging
 *
 * Every denial (any of the four checks above failing) writes an
 * `authz_denied` row to audit_log (Part 5) — actor, restaurant, the
 * permission that was checked, and why it failed. Logging every ALLOWED
 * call too would be far noisier for far less security value (most
 * requests are supposed to succeed); routes that perform something worth
 * its own audit trail regardless of outcome (a refund, a staff removal)
 * should call audit.js's logAudit() themselves.
 *
 * ## Scope
 *
 * Only enforces the four restaurant_staff roles (waiter, kitchen_staff,
 * manager, owner) — see ../authorization/permissions.js for why 'guest'
 * and 'system_admin' aren't covered yet.
 */
export function authorize(permissionKey, options = {}) {
  const { restaurantIdParam = 'restaurantId', abac } = options;

  return async (req, res, next) => {
    if (!req.user) {
      // A route wired authorize() without authenticate() before it —
      // that's a bug in how the route is set up, not something a client
      // did wrong.
      logger.error(`authorize('${permissionKey}'): req.user is not set — authenticate() must run first.`);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Server misconfiguration' } });
    }

    const restaurantId = req.params[restaurantIdParam];
    if (!restaurantId) {
      logger.error(`authorize('${permissionKey}'): no :${restaurantIdParam} param on this route.`);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Server misconfiguration' } });
    }
    if (!UUID_RE.test(restaurantId)) {
      return res.status(400).json({
        error: { code: 'INVALID_REQUEST', message: `${restaurantIdParam} is not a valid id` },
      });
    }

    const deny = async (message) => {
      await logAudit({
        restaurantId,
        action: 'authz_denied',
        actorType: 'staff',
        actorId: req.user.id,
        changes: { permission: permissionKey, reason: message, path: req.originalUrl },
        ipAddress: req.ip,
      });
      return res.status(403).json({ error: { code: 'FORBIDDEN', message } });
    };

    let staff;
    try {
      const result = await pool.query(
        `SELECT id, restaurant_id, role, is_active, name
         FROM restaurant_staff
         WHERE user_id = $1 AND restaurant_id = $2`,
        [req.user.id, restaurantId]
      );
      staff = result.rows[0];
    } catch (err) {
      logger.error(`authorize: staff lookup failed: ${err.message}`);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to authorize request' } });
    }

    if (!staff) {
      return deny('You have no role at this restaurant');
    }
    if (!staff.is_active) {
      return deny('Your access to this restaurant has been deactivated');
    }
    if (!roleGrants(staff.role, permissionKey)) {
      return deny(`Role '${staff.role}' cannot '${permissionKey}'`);
    }

    if (abac) {
      let allowed;
      try {
        allowed = await abac(staff, req);
      } catch (err) {
        logger.error(`authorize: abac check threw: ${err.message}`);
        return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to authorize request' } });
      }
      if (!allowed) {
        return deny('Not allowed for this resource or in its current state');
      }
    }

    req.actor = staff;
    next();
  };
}
