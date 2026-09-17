import path from 'node:path';
import { fileURLToPath } from 'node:url';

import dotenv from 'dotenv';

// A Jest `setupFiles` entry — runs before the test framework and test
// file are loaded, for EVERY test file (Jest gives each test file its
// own module registry, so this must run per-file, not once globally).
// Setting these here, before any app module (db.js, auth.js, ...) is
// ever imported, is what makes them pick up test values: db.js's own
// dotenv.config() call does NOT override already-set process.env vars,
// so whatever is loaded here wins.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '../.env.test') });
