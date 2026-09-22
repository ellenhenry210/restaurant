import { runMigrations } from '../database/migrate.js';
import { logger } from './logger.js';

/**
 * Ensures the database schema is up to date, by applying any migrations
 * in backend/database/migrations/ that haven't run yet (tracked in the
 * schema_migrations table — see that file for the full mechanism).
 *
 * ## Schema design: users vs. restaurant_staff
 *
 * Migration 001 built restaurant_staff as the login/RBAC entity directly
 * (role, email, restaurant_id all on one row). Migration 002 split that:
 *
 *   users              — WHO someone is: email + password_hash. One row
 *                         per person, independent of any restaurant.
 *   restaurant_staff    — WHAT they can do WHERE: a role at a specific
 *                         restaurant, pointing back to users via user_id.
 *
 * Why split it: a person can be staff (even Owner) at more than one
 * restaurant. With everything on one row, that meant either duplicating
 * their password_hash across multiple rows (a change to one wouldn't
 * update the others — a real bug waiting to happen) or simply not
 * supporting it. With the split, one users row can have many
 * restaurant_staff rows — one login, multiple restaurant-scoped roles.
 * (Guests are deliberately NOT in this table at all — they have no
 * password, identified by phone number only, via guest_profiles.)
 *
 * ## Is it safe to call this on every server start?
 *
 * Yes, functionally: runMigrations() only applies migrations that aren't
 * already recorded in schema_migrations, so calling this on a server
 * that's already up to date is a fast no-op (just one SELECT).
 *
 * Whether you SHOULD call it automatically on every boot is a separate,
 * deployment-shaped question:
 *   - Single instance / local dev (where this project is right now):
 *     yes — it's convenient and there's no real downside. That's why
 *     index.js calls this before app.listen().
 *   - Multiple instances behind a load balancer: less clear-cut. Each
 *     instance calling this on boot means multiple processes may race to
 *     apply the same migration at once. Each migration IS wrapped in its
 *     own transaction with schema_migrations.name UNIQUE, so a genuine
 *     race fails loudly (a duplicate-key error) rather than silently
 *     corrupting anything — but "loudly failing on every deploy" isn't
 *     great either. At that point, migrations belong in a single
 *     controlled deploy step (a CI/CD job, or an init container that
 *     runs once before any app instance starts) instead of here.
 */
export async function initDb() {
  logger.info('🔧 Checking database schema...');
  await runMigrations();
}
