import { pool } from '../db.js';
import { roleGrants } from '../authorization/permissions.js';
import { logAudit } from '../audit.js';
import { logger } from '../logger.js';

/**
 * The System Admin counterpart to middleware/authorize.js — same idea
 * (RBAC role grant, checked fresh, every denial audited), different
 * identity source: System Admin isn't a restaurant_staff role, it's
 * platform_admins membership (migration 004), since it's not scoped to
 * any one restaurant.
 *
 * Must run after authenticate() — reads req.user, same as authorize().
 *
 * Usage:
 *   app.get('/v1/platform/analytics', authenticate, requirePlatformAdmin('view_platform_analytics'), handler);
 *
 * There is no real route wired to this yet (see the doc/gap notes) — no
 * platform-level resource exists to protect. It's exported and tested in
 * isolation so it's ready the day one does, rather than built and left
 * completely unverified.
 */
export function requirePlatformAdmin(permissionKey) {
  // Fails at route-setup time in spirit, not per-request: if a route is
  // ever wired to a permission the matrix doesn't grant to system_admin
  // at all, that's a bug in how the route was written, not something any
  // caller could ever satisfy — worth catching loudly rather than
  // quietly 403-ing every single request forever.
  if (!roleGrants('system_admin', permissionKey)) {
    throw new Error(`requirePlatformAdmin: '${permissionKey}' is not granted to system_admin in the permission matrix.`);
  }

  return async (req, res, next) => {
    if (!req.user) {
      logger.error(`requirePlatformAdmin('${permissionKey}'): req.user missing — authenticate() must run first.`);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Server misconfiguration' } });
    }

    let isPlatformAdmin;
    try {
      const result = await pool.query('SELECT id FROM platform_admins WHERE user_id = $1', [req.user.id]);
      isPlatformAdmin = result.rows.length > 0;
    } catch (err) {
      logger.error(`requirePlatformAdmin: lookup failed: ${err.message}`);
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to authorize request' } });
    }

    if (!isPlatformAdmin) {
      // restaurantId: null — this is deliberately NOT restaurant-scoped
      // (migration 005 made audit_log.restaurant_id nullable for
      // exactly this case).
      await logAudit({
        restaurantId: null,
        action: 'authz_denied',
        actorType: 'staff',
        actorId: req.user.id,
        changes: { permission: permissionKey, reason: 'Not a platform admin', path: req.originalUrl },
        ipAddress: req.ip,
      });
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Platform admin access required' } });
    }

    req.platformAdmin = true;
    next();
  };
}
