import rateLimit from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { createClient } from 'redis';

import { logger } from '../logger.js';

// Shared response body for both limiters, matching the error shape used
// elsewhere in the API (see SNAPORDER_API_CONTRACTS.md "Errors").
function rateLimitedResponse(message) {
  return {
    error: {
      code: 'RATE_LIMITED',
      message,
    },
  };
}

// ---------------------------------------------------------------------
// Distributed rate-limit state via Redis (already a project dependency,
// and already running in docker-compose) — closes the previously-flagged
// gap: an in-memory store only limits per-process, so running this as
// more than one instance behind a load balancer let each instance give
// every client its own separate budget.
//
// Deliberately best-effort, not a hard requirement: a single connect
// attempt at startup, with a short timeout and no retry loop. If Redis
// isn't reachable, both limiters fall back to express-rate-limit's own
// in-memory store (store: undefined) — degraded to per-instance limiting,
// not a broken API. NODE_ENV=test skips this entirely: Redis is real,
// shared, persistent state, so a test run's own IP-based counters would
// otherwise accumulate ACROSS every test file (each gets a fresh module
// registry, but not a fresh Redis) — authLimiter's 10-failure budget in
// particular would be exhausted within the first couple of test files
// and start turning expected 401s into 429s everywhere else.
// ---------------------------------------------------------------------
let redisClient;
if (process.env.NODE_ENV !== 'test') {
  try {
    redisClient = createClient({
      socket: {
        host: process.env.REDIS_HOST || 'localhost',
        port: Number(process.env.REDIS_PORT) || 6379,
        connectTimeout: 2000,
        reconnectStrategy: false,
      },
    });
    redisClient.on('error', (err) => logger.error(`Redis client error (rate limiting stays on in-memory): ${err.message}`));
    await redisClient.connect();
    logger.info('Rate limiting: connected to Redis — using a shared store across instances');
  } catch (err) {
    logger.warn(`Rate limiting: Redis unavailable, falling back to in-memory store: ${err.message}`);
    redisClient = undefined;
  }
}

// Two separate RedisStore instances (distinct key prefixes) sharing one
// connection — generalLimiter and authLimiter must not collide on the
// same counters.
function redisStoreOrUndefined(prefix) {
  if (!redisClient) return undefined;
  return new RedisStore({ sendCommand: (...args) => redisClient.sendCommand(args), prefix });
}

/**
 * General-purpose limiter, meant to be applied to the whole API. Generous
 * enough for normal guest browsing/ordering traffic (menu views, cart
 * updates, order status polling) from a single IP, while still bounding
 * scripted/abusive traffic. Not applied to /health, since monitoring/
 * orchestration tools poll that frequently and it does no meaningful work.
 */
export const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 300, // 300 requests per window per IP
  standardHeaders: 'draft-7', // adds RateLimit-Limit / RateLimit-Remaining / RateLimit-Policy headers
  legacyHeaders: false, // skip the older X-RateLimit-* headers — draft-7 supersedes them
  skip: (req) => req.path === '/health',
  message: rateLimitedResponse('Too many requests. Please try again later.'),
  store: redisStoreOrUndefined('rl:general:'),
});

/**
 * Stricter limiter for authentication endpoints (login, register, password
 * reset) — the classic brute-force / credential-stuffing target, so it
 * gets a much tighter budget than general API traffic.
 *
 * skipSuccessfulRequests means only failed attempts count against the
 * limit, so a legitimate user's own successful logins never lock them out
 * — only repeated failures (guessing/stuffing) do.
 */
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 10, // 10 failed attempts per window per IP
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  message: rateLimitedResponse('Too many authentication attempts. Please try again later.'),
  store: redisStoreOrUndefined('rl:auth:'),
});
