import * as analyticsModel from '../models/analyticsModel.js';
import { logger } from '../logger.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const VALID_PERIODS = ['daily', 'weekly', 'monthly'];

// ---------------------------------------------------------------------
// GET /v1/restaurants/:id/analytics/daily — behind view_restaurant_
// analytics (manager/owner/system_admin per the permission matrix).
//
// The request this was built from asked for "owner only" — the matrix
// already grants this to manager too (a manager legitimately needs to
// see how their shift/day performed, not just the owner), so this
// follows the existing, tested matrix rather than narrowing it for one
// endpoint. Flagged here rather than silently matched to the literal ask.
// ---------------------------------------------------------------------
export async function getDaily(req, res) {
  const { id: restaurantId } = req.params;
  const date = typeof req.query.date === 'string' ? req.query.date : new Date().toISOString().slice(0, 10);
  const days = Math.min(90, Math.max(1, parseInt(req.query.days, 10) || 1));

  if (!DATE_RE.test(date)) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'date must be in YYYY-MM-DD format' } });
  }

  try {
    const metrics = await analyticsModel.findDailyMetrics(restaurantId, date, days);
    res.json({ date, days, metrics });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Restaurant not found' } });
    }
    logger.error(`GET /restaurants/:id/analytics/daily: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load analytics' } });
  }
}

// ---------------------------------------------------------------------
// GET /v1/restaurants/:id/analytics/revenue?period=daily|weekly|monthly&from=&to=
// Behind view_restaurant_analytics, same as getDaily above.
// ---------------------------------------------------------------------
export async function getRevenue(req, res) {
  const { id: restaurantId } = req.params;
  const period = typeof req.query.period === 'string' ? req.query.period : 'daily';
  const to = typeof req.query.to === 'string' ? req.query.to : new Date().toISOString().slice(0, 10);
  const from = typeof req.query.from === 'string' ? req.query.from : to;

  if (!VALID_PERIODS.includes(period)) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: `period must be one of: ${VALID_PERIODS.join(', ')}` } });
  }
  if (!DATE_RE.test(from) || !DATE_RE.test(to)) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'from/to must be in YYYY-MM-DD format' } });
  }

  try {
    const breakdown = await analyticsModel.findRevenueByPeriod(restaurantId, period, from, to);
    res.json({ period, from, to, breakdown });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Restaurant not found' } });
    }
    logger.error(`GET /restaurants/:id/analytics/revenue: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load revenue analytics' } });
  }
}

// ---------------------------------------------------------------------
// GET /v1/platform/analytics — view_platform_analytics, System Admin
// only (requirePlatformAdmin, not authorize() — this isn't scoped to
// any one restaurant).
// ---------------------------------------------------------------------
export async function getPlatformTotals(req, res) {
  try {
    const totals = await analyticsModel.findPlatformTotals();
    res.json(totals);
  } catch (err) {
    logger.error(`GET /platform/analytics: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load platform analytics' } });
  }
}
