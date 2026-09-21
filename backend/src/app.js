import express from 'express';
import dotenv from 'dotenv';

import { generalLimiter, authLimiter } from './middleware/rateLimit.js';
import { authenticate } from './middleware/auth.js';
import authRoutes from './routes/auth.js';
import staffRoutes from './routes/staff.js';
import guestSessionRoutes from './routes/guestSession.js';
import restaurantRoutes from './routes/restaurants.js';
import menuRoutes from './routes/menus.js';
import orderRoutes from './routes/orders.js';
import restaurantOrderRoutes from './routes/restaurantOrders.js';
import tableRoutes from './routes/tables.js';
import paymentRoutes from './routes/payments.js';
import qrRoutes from './routes/qr.js';
import billRoutes from './routes/bills.js';
import staffCallRoutes from './routes/staffCalls.js';

// Split out of index.js (2026-09-17) so the Express app can be imported
// on its own — by supertest in integration tests, or by anything else
// that wants the app without also starting a real HTTP listener and
// Socket.io (see index.js for that half: createServer/initRealtime/
// start()/listen()).
dotenv.config();

export const app = express();

// Applied before express.json() so an over-limit request is rejected
// cheaply, without paying the cost of parsing its body first.
app.use(generalLimiter);

// Mounted BEFORE express.json(): the webhook handler verifies Paystack's
// HMAC signature against the exact raw request bytes (routes/payments.js
// parses this one route's body with express.raw(), not JSON) — parsing
// to JSON first and re-serializing later would change the bytes and
// break every legitimate signature.
app.use('/v1/payments', paymentRoutes);

app.use(express.json());

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.get('/', (req, res) => {
  res.json({ message: 'SnapOrder API', version: '1.0.0' });
});

// /v1 prefix: this is the first real route mounted, so it's the right
// moment to start versioning (SNAPORDER_GITHUB_SETUP.md already lists
// "API versioning from day 1" as non-negotiable, and SNAPORDER_API_
// CONTRACTS.md was designed around /v1/ throughout — it just hadn't
// been wired up in code yet). authLimiter applies in addition to (not
// instead of) the global generalLimiter, tightening the budget
// specifically for login/register.
app.use('/v1/auth', authLimiter, authRoutes);

// A small "who am I" route — not explicitly requested, but the natural
// way to prove the authenticate middleware works end-to-end, and
// genuinely useful (e.g. for a frontend to check "is my token still
// good" on load).
app.get('/v1/me', authenticate, (req, res) => {
  res.json({ user: req.user });
});

// First real use of authorize() — see routes/staff.js.
app.use('/v1/restaurants/:restaurantId/staff', staffRoutes);

// Guest entry point: POST /v1/tables/:qrCodeId/scan (proximity-gated
// session issuance) and GET /v1/guest/session (authenticateGuest demo).
// Not behind authenticate/authorize — guests have no staff identity at
// all; see routes/guestSession.js and middleware/authGuest.js.
app.use('/v1', guestSessionRoutes);

// Public read endpoints — no auth. See routes/restaurants.js and
// routes/menus.js for why (view_menu has no ABAC condition in the
// permission matrix; a public directory/menu view is the natural
// reading of that, distinct from ordering itself, which does require
// a proximity-verified guest session below).
app.use('/v1/restaurants', restaurantRoutes);
app.use('/v1', menuRoutes); // /v1/restaurants/:id/menus, /v1/meals/:id, /v1/meals/:id/ingredients

// Guest ordering — behind authenticateGuest. See routes/orders.js for
// the full lifecycle and the allergen removal-policy enforcement.
app.use('/v1/orders', orderRoutes);

// Staff/kitchen side of order management — behind authenticate +
// authorize(). See routes/restaurantOrders.js.
app.use('/v1/restaurants/:restaurantId/orders', restaurantOrderRoutes);

// Table-to-staff assignment ("who's serving this table") — behind
// authenticate + authorize(). See routes/tables.js.
app.use('/v1/restaurants/:restaurantId/tables', tableRoutes);

// Table QR code generation — behind authenticate + authorize(). See
// routes/qr.js for why this is its own top-level namespace instead of
// nesting under the tables mount above.
app.use('/v1/qr', qrRoutes);

// Table-level billing (SNAPORDER_DATABASE_SCHEMA.md's "Payment & Billing
// Model") — guest-facing, behind authenticateGuest. See routes/bills.js
// for why this is mounted at /v1 rather than a resource prefix.
app.use('/v1', billRoutes);

// Staff-side of the Pay-Traditionally "call the waiter" flow — behind
// authenticate + authorize('process_payment'). See routes/staffCalls.js.
app.use('/v1/restaurants/:restaurantId/staff-calls', staffCallRoutes);

// 404 for anything that didn't match a route above — must come after
// every real route. Without this, an unmatched path (a typo, a
// deprecated endpoint) falls through to Express's default HTML 404
// page instead of this API's JSON error format.
app.use((req, res) => {
  res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No such route' } });
});

// Centralized error handler — must be registered LAST, and must take
// exactly 4 parameters (err, req, res, next); that arity is how Express
// recognizes it as error-handling middleware rather than a normal one.
//
// Every route in this app already wraps its own logic in try/catch and
// responds directly, so this isn't the primary path for "expected"
// errors — it's the safety net for what those try/catches can't reach:
// - express.json() rejecting a malformed or oversized body (it calls
//   next(err) itself; without this handler that error falls through to
//   Express's default HTML error page, not this API's JSON format).
// - A route handler that throws synchronously outside its own
//   try/catch, or a bug introduced later that forgets one.
// - Any middleware (auth, rate limiting) that ever calls next(err)
//   instead of responding directly.
app.use((err, req, res, next) => {
  if (res.headersSent) {
    // A response is already underway — Express's own default handler
    // is the correct thing to delegate to here, not another res.json().
    return next(err);
  }

  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'Malformed JSON body' } });
  }
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: { code: 'INVALID_REQUEST', message: 'Request body too large' } });
  }

  console.error('Unhandled error:', err);
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' } });
});

export default app;
