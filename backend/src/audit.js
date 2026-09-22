import { pool } from './db.js';
import { logger } from './logger.js';

/**
 * Writes one row to audit_log (SNAPORDER_DATABASE_SCHEMA.md table 17;
 * SNAPORDER_AUTHORIZATION.md Part 5). Shared by middleware/authorize.js
 * (every denial) and available to route handlers for significant allowed
 * actions (e.g. a refund, a staff removal) — logging those per-route is
 * still manual/opt-in today, not automatic, since "significant" is
 * route-specific.
 *
 * Deliberately swallows its own errors: a failure to WRITE an audit
 * record should never be the reason a request itself fails (worse to
 * turn an audit-logging bug into an outage than to occasionally miss a
 * log line — though a failure here is itself logged to the console so
 * it doesn't go completely unnoticed).
 */
export async function logAudit({
  // null (not just omitted) for platform-level actions with no single
  // restaurant to attach to — audit_log.restaurant_id is nullable for
  // exactly this (migration 005).
  restaurantId = null,
  action,
  actorType = 'system',
  actorId = null,
  resourceType = null,
  resourceId = null,
  changes = null,
  ipAddress = null,
}) {
  try {
    await pool.query(
      `INSERT INTO audit_log (restaurant_id, action, actor_type, actor_id, resource_type, resource_id, changes, ip_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [restaurantId, action, actorType, actorId, resourceType, resourceId, changes ? JSON.stringify(changes) : null, ipAddress]
    );
  } catch (err) {
    logger.error(`logAudit: failed to write audit_log row: ${err.message}`);
  }
}
