import * as restaurantModel from '../models/restaurantModel.js';
import { logger } from '../logger.js';

// ---------------------------------------------------------------------
// GET /restaurants — list active restaurants. Public: no authenticate/
// authorize here, same reasoning as menuController.js — this is a
// directory/discovery view, not restaurant-internal data.
// ---------------------------------------------------------------------
export async function list(req, res) {
  // Basic pagination — an unbounded "return every restaurant" query
  // gets worse (and slower) as the platform grows; bounding it from day
  // one avoids a query that's fine at 20 restaurants and a real problem
  // at 20,000.
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const perPage = Math.min(50, Math.max(1, parseInt(req.query.per_page, 10) || 20));
  const offset = (page - 1) * perPage;

  try {
    const [rows, total] = await Promise.all([
      restaurantModel.findActive({ limit: perPage, offset }),
      restaurantModel.countActive(),
    ]);

    res.json({
      data: rows,
      pagination: { total, page, per_page: perPage },
    });
  } catch (err) {
    logger.error(`GET /restaurants: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list restaurants' } });
  }
}

// ---------------------------------------------------------------------
// GET /restaurants/:id — single restaurant. Returns inactive restaurants
// too (an inactive one isn't "not found", it's "temporarily
// unavailable" — a client can tell the difference from is_active in the
// response and show an appropriate message, rather than getting an
// indistinguishable 404).
// ---------------------------------------------------------------------
export async function getOne(req, res) {
  try {
    const restaurant = await restaurantModel.findById(req.params.id);

    if (!restaurant) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Restaurant not found' } });
    }

    res.json(restaurant);
  } catch (err) {
    // A malformed (non-UUID) :id makes Postgres itself throw, not just
    // return zero rows — treat that as "not found" too rather than a
    // 500, since from the caller's perspective a garbage id and a
    // nonexistent one both just mean "no such restaurant."
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Restaurant not found' } });
    }
    logger.error(`GET /restaurants/:id: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load restaurant' } });
  }
}
