import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Runs once, in its own process, before any test file — separate from
// tests/setupEnv.js (a `setupFiles` entry, re-run per test file). Makes
// `npm test` fully self-contained: create the test database if it
// doesn't exist yet, then bring it up to date with every migration, the
// same way `npm run migrate` does for the dev database. No manual setup
// step required, locally or in CI.
export default async function globalSetup() {
  dotenv.config({ path: path.join(__dirname, '../.env.test') });

  const { Client } = pg;
  // Connects to the server's default `postgres` maintenance database —
  // not snaporder_test itself, which may not exist yet at this point.
  const admin = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: 'postgres',
  });
  await admin.connect();
  try {
    const exists = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [process.env.DB_NAME]);
    if (exists.rows.length === 0) {
      // Database names can't be parameterized — safe here regardless,
      // since it only ever comes from our own .env.test, never request
      // input.
      await admin.query(`CREATE DATABASE "${process.env.DB_NAME}"`);
    }
  } finally {
    await admin.end();
  }

  const { runMigrations } = await import('../database/migrate.js');
  await runMigrations();
  const { pool } = await import('../src/db.js');
  await pool.end();
}
