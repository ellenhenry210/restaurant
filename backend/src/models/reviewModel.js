import { pool } from '../db.js';

/** The order + which meals were actually in it — used to verify a review's meal_id was genuinely ordered, and to resolve the restaurant/table for ownership checks. */
export async function findOrderForReview(orderId, executor = pool) {
  const result = await executor.query(
    `SELECT id, restaurant_id, table_id, guest_profile_id FROM orders WHERE id = $1`,
    [orderId]
  );
  return result.rows[0] ?? null;
}

export async function orderIncludesMeal(orderId, mealId, executor = pool) {
  const result = await executor.query(`SELECT 1 FROM order_items WHERE order_id = $1 AND meal_id = $2 LIMIT 1`, [orderId, mealId]);
  return result.rows.length > 0;
}

export async function insertReview(data, executor = pool) {
  const result = await executor.query(
    `INSERT INTO guest_reviews (order_id, meal_id, guest_profile_id, rating, review_text, photo_url, has_allergen_issue, allergen_issue_description)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, order_id, meal_id, rating, review_text, photo_url, has_allergen_issue, allergen_issue_description, is_public, created_at`,
    [
      data.orderId,
      data.mealId,
      data.guestProfileId,
      data.rating,
      data.reviewText ?? null,
      data.photoUrl ?? null,
      data.hasAllergenIssue ?? false,
      data.allergenIssueDescription ?? null,
    ]
  );
  return result.rows[0];
}

/** @returns {Promise<object|null>} includes the owning order's restaurant_id/guest_profile_id, needed for both the guest-edit ownership check and the staff reply/moderate restaurant check. */
export async function findReviewById(reviewId, executor = pool) {
  const result = await executor.query(
    `SELECT gr.*, o.restaurant_id
     FROM guest_reviews gr
     JOIN orders o ON o.id = gr.order_id
     WHERE gr.id = $1`,
    [reviewId]
  );
  return result.rows[0] ?? null;
}

export async function updateReview(reviewId, data, executor = pool) {
  const result = await executor.query(
    `UPDATE guest_reviews
     SET rating = $1, review_text = $2, photo_url = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $4
     RETURNING id, rating, review_text, photo_url, updated_at`,
    [data.rating, data.reviewText ?? null, data.photoUrl ?? null, reviewId]
  );
  return result.rows[0];
}

export async function setReviewVisibility(reviewId, isPublic, executor = pool) {
  const result = await executor.query(
    `UPDATE guest_reviews SET is_public = $1, updated_at = CURRENT_TIMESTAMP WHERE id = $2 RETURNING id, is_public`,
    [isPublic, reviewId]
  );
  return result.rows[0];
}

/** Public reviews for a restaurant, with the restaurant's own response (if any) joined in — the "transparency" surface guests actually see. */
export async function findPublicReviews(restaurantId, mealId, executor = pool) {
  const result = await executor.query(
    `SELECT gr.id, gr.meal_id, m.name AS meal_name, gr.rating, gr.review_text, gr.photo_url, gr.helpful_count, gr.created_at,
            rr.id AS response_id, rr.response_text, rr.created_at AS response_created_at
     FROM guest_reviews gr
     JOIN orders o ON o.id = gr.order_id
     JOIN meals m ON m.id = gr.meal_id
     LEFT JOIN restaurant_responses rr ON rr.review_id = gr.id AND rr.is_public = TRUE
     WHERE o.restaurant_id = $1 AND gr.is_public = TRUE
       AND ($2::uuid IS NULL OR gr.meal_id = $2)
     ORDER BY gr.created_at DESC`,
    [restaurantId, mealId ?? null]
  );
  return result.rows.map((r) => ({
    id: r.id,
    meal_id: r.meal_id,
    meal_name: r.meal_name,
    rating: r.rating,
    review_text: r.review_text,
    photo_url: r.photo_url,
    helpful_count: r.helpful_count,
    created_at: r.created_at,
    response: r.response_id ? { text: r.response_text, created_at: r.response_created_at } : null,
  }));
}

export async function insertResponse(reviewId, staffId, responseText, executor = pool) {
  const result = await executor.query(
    `INSERT INTO restaurant_responses (review_id, staff_id, response_text) VALUES ($1, $2, $3)
     RETURNING id, review_id, response_text, created_at`,
    [reviewId, staffId, responseText]
  );
  return result.rows[0];
}
