import { pool } from '../db.js';
import { logger } from '../logger.js';

/**
 * The ownership+is_active half of authorize() (../middleware/authorize.js),
 * without the role-grant/ABAC steps — for the rare action any active
 * staff member can take regardless of role, where no single permission
 * in the matrix represents "any staff role" (creating a feature
 * suggestion is the first case of this: the matrix only defines
 * vote_suggestion/set_roadmap_status, not a "create" permission, and the
 * schema's created_by_staff_id column already implies any role can).
 *
 * Sets req.actor, same shape as authorize(), so downstream handlers
 * don't need to care which of the two middlewares ran.
 */
export function requireActiveStaff(restaurantIdParam = 'restaurantId') {
  return async (req, res, next) => {
    if (!req.user) {
      logger.error('requireActiveStaff: req.user is not set — authenticate() must run first.');
      return res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Server misconfiguration' } });
    }

    const restaurantId = req.params[restaurantIdParam];
    try {
      const result = await pool.query(
        `SELECT id, restaurant_id, role, is_active, name
         FROM restaurant_staff
         WHERE user_id = $1 AND restaurant_id = $2`,
        [req.user.id, restaurantId]
      );
      const staff = result.rows[0];
      if (!staff || !staff.is_active) {
        return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'You have no active role at this restaurant' } });
      }
      req.actor = staff;
      next();
    } catch (err) {
      logger.error(`requireActiveStaff: lookup failed: ${err.message}`);
      res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to authorize request' } });
    }
  };
}
