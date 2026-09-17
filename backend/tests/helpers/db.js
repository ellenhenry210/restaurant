import { pool } from '../../src/db.js';

/**
 * Wipes every app table between tests, for isolation — TRUNCATE ...
 * CASCADE on the handful of "root" tables (nothing else references INTO
 * them from outside this list) clears every FK-dependent table
 * transitively. schema_migrations is deliberately excluded: it tracks
 * which migrations ran, not test data, and truncating it would make
 * migrate.js re-apply everything on the next run.
 */
export async function resetDb() {
  await pool.query(
    `TRUNCATE restaurants, users, platform_admins RESTART IDENTITY CASCADE`
  );
}

export async function closeDb() {
  await pool.end();
}
