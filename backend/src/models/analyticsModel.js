import { pool } from '../db.js';

const PERIOD_TO_TRUNC_UNIT = { daily: 'day', weekly: 'week', monthly: 'month' };

/**
 * Per-period revenue breakdown — the "/analytics/revenue" endpoint
 * flagged as still-missing alongside the original daily-metrics work.
 * Distinct from findDailyMetrics: that one collapses a whole window into
 * a single summary; this one buckets it (one row per day/week/month).
 * @returns {Promise<{period_start, orders, revenue}[]>}
 */
export async function findRevenueByPeriod(restaurantId, period, from, to, executor = pool) {
  const truncUnit = PERIOD_TO_TRUNC_UNIT[period];
  const result = await executor.query(
    `SELECT date_trunc($4, placed_at) AS period_start,
            COUNT(*) AS orders,
            COALESCE(SUM(total_amount), 0) AS revenue
     FROM orders
     WHERE restaurant_id = $1
       AND placed_at >= $2::date
       AND placed_at < ($3::date + INTERVAL '1 day')
       AND status != 'cancelled'
     GROUP BY period_start
     ORDER BY period_start ASC`,
    [restaurantId, from, to, truncUnit]
  );
  return result.rows.map((r) => ({
    period_start: r.period_start,
    orders: Number(r.orders),
    revenue: Number(r.revenue),
  }));
}

/**
 * Cross-restaurant totals — view_platform_analytics, System Admin only.
 * All-time, not date-ranged: a platform-level "how big is SnapOrder
 * right now" snapshot, not a report — a date-ranged version can be
 * added if/when that's actually asked for, not speculatively now.
 */
export async function findPlatformTotals(executor = pool) {
  const result = await executor.query(
    `SELECT
       (SELECT COUNT(*) FROM restaurants) AS total_restaurants,
       (SELECT COUNT(*) FROM restaurants WHERE is_active) AS active_restaurants,
       (SELECT COUNT(*) FROM orders WHERE status != 'cancelled') AS total_orders,
       (SELECT COALESCE(SUM(total_amount), 0) FROM orders WHERE status != 'cancelled') AS total_revenue,
       (SELECT COUNT(DISTINCT id) FROM guest_profiles) AS total_guest_profiles`
  );
  const r = result.rows[0];
  return {
    total_restaurants: Number(r.total_restaurants),
    active_restaurants: Number(r.active_restaurants),
    total_orders: Number(r.total_orders),
    total_revenue: Number(r.total_revenue),
    total_guest_profiles: Number(r.total_guest_profiles),
  };
}

/**
 * Daily/period restaurant metrics, matching the shape already sketched in
 * SNAPORDER_API_CONTRACTS.md's Analytics Dashboard section. `days` widens
 * the window to [date, date+days) rather than adding a per-day breakdown
 * — that's the (still unbuilt) /analytics/revenue endpoint's job.
 * Cancelled orders/items are excluded throughout: a cancelled order was
 * never actually served, so it shouldn't count as revenue or a meal sold.
 * @returns {Promise<object>}
 */
export async function findDailyMetrics(restaurantId, date, days, executor = pool) {
  const summaryResult = await executor.query(
    `WITH range_orders AS (
       SELECT * FROM orders
       WHERE restaurant_id = $1
         AND placed_at >= $2::date
         AND placed_at < ($2::date + ($3 || ' days')::interval)
         AND status != 'cancelled'
     )
     SELECT
       (SELECT COUNT(*) FROM range_orders) AS total_orders,
       (SELECT COALESCE(SUM(total_amount), 0) FROM range_orders) AS total_revenue,
       (SELECT COALESCE(SUM(oi.quantity), 0)
          FROM order_items oi JOIN range_orders ro ON ro.id = oi.order_id
          WHERE oi.status != 'cancelled') AS meals_sold,
       (SELECT AVG(EXTRACT(EPOCH FROM (ro.ready_at - ro.confirmed_at)) / 60)
          FROM range_orders ro WHERE ro.ready_at IS NOT NULL AND ro.confirmed_at IS NOT NULL) AS average_prep_time_minutes,
       (SELECT AVG(gr.rating) FROM guest_reviews gr JOIN range_orders ro ON ro.id = gr.order_id) AS guest_satisfaction_rating,
       (SELECT COUNT(DISTINCT oi.order_id)
          FROM order_items oi JOIN range_orders ro ON ro.id = oi.order_id JOIN meals m ON m.id = oi.meal_id
          WHERE m.is_low_calorie) AS low_calorie_orders,
       (SELECT COUNT(DISTINCT oi.order_id)
          FROM order_items oi JOIN range_orders ro ON ro.id = oi.order_id JOIN meals m ON m.id = oi.meal_id
          WHERE m.is_high_protein) AS high_protein_orders,
       (SELECT COUNT(DISTINCT oi.order_id)
          FROM order_items oi JOIN range_orders ro ON ro.id = oi.order_id JOIN meals m ON m.id = oi.meal_id
          WHERE m.is_vegan) AS vegan_orders`,
    [restaurantId, date, days]
  );

  const topMealsResult = await executor.query(
    `SELECT oi.meal_id, oi.meal_name AS name, SUM(oi.quantity) AS quantity_sold, SUM(oi.meal_price * oi.quantity) AS revenue
     FROM order_items oi
     JOIN orders o ON o.id = oi.order_id
     WHERE o.restaurant_id = $1
       AND o.placed_at >= $2::date
       AND o.placed_at < ($2::date + ($3 || ' days')::interval)
       AND o.status != 'cancelled'
       AND oi.status != 'cancelled'
     GROUP BY oi.meal_id, oi.meal_name
     ORDER BY SUM(oi.quantity) DESC
     LIMIT 5`,
    [restaurantId, date, days]
  );

  const s = summaryResult.rows[0];
  const totalOrders = Number(s.total_orders);
  const totalRevenue = Number(s.total_revenue);

  return {
    total_orders: totalOrders,
    total_revenue: totalRevenue,
    average_order_value: totalOrders > 0 ? Math.round((totalRevenue / totalOrders) * 100) / 100 : 0,
    meals_sold: Number(s.meals_sold),
    top_meals: topMealsResult.rows.map((r) => ({
      meal_id: r.meal_id,
      name: r.name,
      quantity_sold: Number(r.quantity_sold),
      revenue: Number(r.revenue),
    })),
    customer_health_trends: {
      low_calorie_orders: Number(s.low_calorie_orders),
      high_protein_orders: Number(s.high_protein_orders),
      vegan_orders: Number(s.vegan_orders),
    },
    average_prep_time_minutes: s.average_prep_time_minutes !== null ? Math.round(Number(s.average_prep_time_minutes)) : null,
    guest_satisfaction_rating: s.guest_satisfaction_rating !== null ? Math.round(Number(s.guest_satisfaction_rating) * 10) / 10 : null,
  };
}
