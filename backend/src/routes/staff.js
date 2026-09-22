import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';

import { pool } from '../db.js';
import { authenticate } from '../middleware/auth.js';
import { authorize } from '../middleware/authorize.js';
import { validate } from '../middleware/validate.js';
import { STAFF_ROLES } from '../authorization/permissions.js';
import { logger } from '../logger.js';

// mergeParams: true — this router is mounted at
// /v1/restaurants/:restaurantId/staff (see index.js), and needs that
// :restaurantId param in its own req.params. Express doesn't pass parent
// route params down to a mounted router by default.
const router = Router({ mergeParams: true });

const MIN_PASSWORD_LENGTH = 8;
const BCRYPT_SALT_ROUNDS = 12;

// password's requiredness depends on whether the email already has an
// account — a DB lookup the schema can't see — so that half of the rule
// stays in the handler below, same as before. This only covers what a
// schema genuinely can validate statically.
const addStaffSchema = z.object({
  email: z.string().min(1, 'required').email('must be a valid email address'),
  name: z.string().min(1, 'required'),
  display_name: z.string().optional(),
  role: z.enum(STAFF_ROLES, { message: `must be one of: ${STAFF_ROLES.join(', ')}` }),
  password: z.string().optional(),
  phone: z.string().optional(),
});

const updateStaffSchema = z.object({
  display_name: z.string().nullable(),
});

// GET /v1/restaurants/:restaurantId/staff — first real demonstration of
// authorize() end-to-end: 'view_staff' is Manager/Owner/System Admin
// only per SNAPORDER_AUTHORIZATION.md Part 1, and every call is scoped
// to the :restaurantId in the URL by authorize()'s built-in ownership
// check, regardless of what other restaurants the caller might also be
// staff at.
router.get('/', authenticate, authorize('view_staff'), async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, display_name, role, is_active, created_at
       FROM restaurant_staff
       WHERE restaurant_id = $1
       ORDER BY created_at ASC`,
      [req.params.restaurantId]
    );
    res.json({ data: result.rows });
  } catch (err) {
    logger.error(`GET /staff: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list staff' } });
  }
});

// ---------------------------------------------------------------------
// POST /v1/restaurants/:restaurantId/staff — add staff to a restaurant
// that already exists (POST /v1/auth/register only covers onboarding a
// brand-new restaurant + its first Owner — this was the other half of
// that gap). 'manage_staff' (hire/remove) is Owner/System Admin only
// per the matrix — a Manager can view staff but not add them.
//
// Reuses an existing users row by email when one exists, rather than
// always creating a new login — this is the whole point of the users/
// restaurant_staff split (SNAPORDER_DATABASE_SCHEMA.md table 19): the
// same person can be added as staff at a second restaurant using the
// login they already have, without a separate password to manage.
// ---------------------------------------------------------------------
router.post('/', authenticate, authorize('manage_staff'), validate(addStaffSchema), async (req, res) => {
  const { email, name, display_name: displayName, role, password, phone } = req.body;

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const existingUser = await client.query('SELECT id FROM users WHERE email = $1', [email]);
    let userId = existingUser.rows[0]?.id;

    if (userId) {
      // Reusing an existing login — a password in the body here would
      // be silently ignored otherwise, which could mislead the caller
      // into thinking they'd just set/changed it. Reject explicitly
      // instead.
      if (password !== undefined) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: { code: 'INVALID_REQUEST', message: 'This email already has an account — omit password to add them using their existing login' },
        });
      }
    } else {
      if (!password || typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
        await client.query('ROLLBACK');
        return res.status(400).json({
          error: { code: 'INVALID_REQUEST', message: 'One or more fields are invalid', details: [{ field: 'password', reason: `required (new account) and must be at least ${MIN_PASSWORD_LENGTH} characters` }] },
        });
      }
      const passwordHash = await bcrypt.hash(password, BCRYPT_SALT_ROUNDS);
      const created = await client.query('INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id', [email, passwordHash]);
      userId = created.rows[0].id;
    }

    const staffResult = await client.query(
      `INSERT INTO restaurant_staff (restaurant_id, user_id, name, display_name, role, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, display_name, role, phone, is_active, created_at`,
      [req.params.restaurantId, userId, name, displayName ?? null, role, phone ?? null]
    );

    await client.query('COMMIT');
    res.status(201).json(staffResult.rows[0]);
  } catch (err) {
    await client.query('ROLLBACK');
    if (err.code === '23505') {
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'This person is already staff at this restaurant' } });
    }
    logger.error(`POST /staff: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to add staff' } });
  } finally {
    client.release();
  }
});

// ---------------------------------------------------------------------
// PATCH /:staffId — update a staff member's display_name. "Customizable"
// implies editable, not just set once at creation. Gated by manage_staff
// like the rest of this file, not left open for self-service editing —
// there's no "edit my own profile" route/concept yet (would need its
// own identity check: req.user.id maps to which restaurant_staff row),
// so for now only an Owner/System Admin can change it.
// ---------------------------------------------------------------------
router.patch('/:staffId', authenticate, authorize('manage_staff'), validate(updateStaffSchema), async (req, res) => {
  const { display_name: displayName } = req.body;

  try {
    const result = await pool.query(
      `UPDATE restaurant_staff
       SET display_name = $1, updated_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND restaurant_id = $3
       RETURNING id, name, display_name, role, is_active`,
      [displayName ?? null, req.params.staffId, req.params.restaurantId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Staff member not found' } });
    }

    res.json(result.rows[0]);
  } catch (err) {
    logger.error(`PATCH /staff/:staffId: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update staff member' } });
  }
});

export default router;
