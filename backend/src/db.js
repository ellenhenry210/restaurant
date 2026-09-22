import pg from 'pg';
import dotenv from 'dotenv';
import { logger } from './logger.js';

// Unlike auth.js, this module calls dotenv.config() itself, right here, at
// the top — before reading any process.env values below. That sidesteps
// the ESM import-hoisting footgun we hit with auth.js: if db.js were
// imported before some *other* file's dotenv.config() call ran, reading
// process.env at module load would capture `undefined`. Loading dotenv
// ourselves means this module is self-contained regardless of import
// order. dotenv.config() is safe to call more than once (later calls are
// no-ops for variables already set), so this doesn't conflict with
// index.js also calling it.
dotenv.config();

const { Pool } = pg;

// Fail fast if the credentials this module actually needs aren't set —
// same reasoning as JWT_SECRET in auth.js: a pool silently constructed
// with `undefined` values doesn't fail until the first query, which is a
// much more confusing place to debug a config problem from.
const required = ['DB_NAME', 'DB_USER', 'DB_PASSWORD'];
const missing = required.filter((key) => !process.env[key]);
if (missing.length > 0) {
  throw new Error(
    `Missing required database env var(s): ${missing.join(', ')}. Check your .env file (see .env.example).`
  );
}

/**
 * The connection pool. Import this directly (`import { pool } from
 * './db.js'`) when you need to run a query, or use the query() helper
 * below, which adds basic logging/error context on top of pool.query().
 */
export const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5432,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,

  // Pool sizing — see the connection-pooling explanation for what these
  // control. Reasonable defaults for a single-instance deployment; not
  // read from .env since there's no proven need to tune them per
  // environment yet (see engineering-practices: avoid premature config).
  max: 20, // max simultaneous clients checked out from the pool
  idleTimeoutMillis: 30_000, // close an idle client after 30s
  connectionTimeoutMillis: 5_000, // fail fast if the DB can't be reached
});

// Fired when an already-connected, idle client errors out from under us —
// e.g. the database restarted or the network dropped. This does NOT fire
// for errors on queries you're actively awaiting (those reject the query's
// own promise instead); it's specifically for background/idle clients.
// We log rather than crash the process: for a request-serving API, a
// transient DB blip shouldn't take the whole server down along with it —
// the next query attempt will simply try to acquire a fresh client.
pool.on('error', (err) => {
  logger.error(`Unexpected error on idle PostgreSQL client: ${err.message}`);
});

/**
 * Run a query through the pool, with basic timing/error logging on top of
 * the raw pg API. Prefer this over calling pool.query() directly so slow
 * or failing queries are consistently logged.
 *
 * @param {string} text - SQL text, with $1/$2/... placeholders.
 * @param {Array} [params] - Values for the placeholders.
 * @returns {Promise<import('pg').QueryResult>}
 */
export async function query(text, params) {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const durationMs = Date.now() - start;
    if (durationMs > 200) {
      // Cheap slow-query signal without pulling in a full logging library
      // yet (see known-gaps: structured logging is still unimplemented).
      logger.warn(`Slow query (${durationMs}ms): ${text}`);
    }
    return result;
  } catch (err) {
    logger.error('Query failed:', { text, params, error: err.message });
    throw err; // Let the caller decide how to respond (e.g. a 500) — this
               // helper adds logging, it doesn't swallow the failure.
  }
}

/**
 * Verify the database is actually reachable and query-able. Intended for
 * use at server startup (fail loudly before accepting traffic) and for a
 * `/health` endpoint that wants to check real DB connectivity rather than
 * just "the process is up" (see known-gaps).
 *
 * @returns {Promise<boolean>} true if the test query succeeded.
 */
export async function testConnection() {
  let client;
  try {
    client = await pool.connect(); // checks a client out of the pool
    const result = await client.query('SELECT NOW() AS current_time, version() AS pg_version');
    logger.info(`✅ Database connection OK: ${result.rows[0].current_time}`);
    return true;
  } catch (err) {
    logger.error(`❌ Database connection failed: ${err.message}`);
    return false;
  } finally {
    // Always release the client back to the pool, whether the query
    // succeeded or failed — otherwise this connection is leaked and
    // never returns to the pool for reuse.
    client?.release();
  }
}
