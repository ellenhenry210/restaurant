import { z } from 'zod';

import * as reviewModel from '../models/reviewModel.js';
import { logger } from '../logger.js';

const EDIT_WINDOW_HOURS = 48;

export const leaveReviewSchema = z.object({
  meal_id: z.string().min(1, 'required'),
  rating: z.number().int('must be an integer between 1 and 5').min(1).max(5),
  review_text: z.string().optional(),
  photo_url: z.string().optional(),
  has_allergen_issue: z.boolean().optional(),
  allergen_issue_description: z.string().optional(),
});

export const editReviewSchema = z.object({
  rating: z.number().int('must be an integer between 1 and 5').min(1).max(5),
  review_text: z.string().optional(),
  photo_url: z.string().optional(),
});

export const respondSchema = z.object({
  response_text: z.string().min(1, 'required'),
});

export const moderateSchema = z.object({
  is_public: z.boolean(),
});

// ---------------------------------------------------------------------
// POST /orders/:orderId/reviews — leave_review. The meal reviewed must
// genuinely have been in this order (not any meal at the restaurant) —
// a review is "I ate this", not a general comment box.
// ---------------------------------------------------------------------
export async function create(req, res) {
  const { orderId } = req.params;
  const { meal_id: mealId, rating, review_text: reviewText, photo_url: photoUrl, has_allergen_issue: hasAllergenIssue, allergen_issue_description: allergenIssueDescription } = req.body;

  try {
    const order = await reviewModel.findOrderForReview(orderId);
    if (!order) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    if (order.table_id !== req.guestSession.table_id || order.restaurant_id !== req.guestSession.restaurant_id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This order does not belong to your table' } });
    }
    if (!order.guest_profile_id) {
      // Shouldn't happen in practice — placing an order always creates/
      // links a guest_profile — but a review has nowhere to attach
      // without one, so fail closed rather than insert a dangling row.
      return res.status(409).json({ error: { code: 'CONFLICT', message: 'This order has no guest profile to attach a review to' } });
    }
    if (!(await reviewModel.orderIncludesMeal(orderId, mealId))) {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'That meal was not part of this order' } });
    }

    const review = await reviewModel.insertReview({
      orderId,
      mealId,
      guestProfileId: order.guest_profile_id,
      rating,
      reviewText,
      photoUrl,
      hasAllergenIssue,
      allergenIssueDescription,
    });

    res.status(201).json(review);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Order not found' } });
    }
    if (err.code === '23503') {
      return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'meal_id does not exist' } });
    }
    logger.error(`POST /orders/:orderId/reviews: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create review' } });
  }
}

// ---------------------------------------------------------------------
// PATCH /reviews/:reviewId — edit_own_review. Ownership via
// guest_profile_id (not table — a review can outlive the session that
// created it), and only within EDIT_WINDOW_HOURS of creation, per the
// product's documented ABAC condition.
// ---------------------------------------------------------------------
export async function update(req, res) {
  const { reviewId } = req.params;
  const { rating, review_text: reviewText, photo_url: photoUrl } = req.body;

  try {
    const review = await reviewModel.findReviewById(reviewId);
    if (!review) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found' } });
    }
    if (review.guest_profile_id !== req.guestSession.guest_profile_id) {
      return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'This review does not belong to you' } });
    }
    const ageHours = (Date.now() - new Date(review.created_at).getTime()) / (1000 * 60 * 60);
    if (ageHours > EDIT_WINDOW_HOURS) {
      return res.status(409).json({ error: { code: 'CONFLICT', message: `Reviews can only be edited within ${EDIT_WINDOW_HOURS} hours of posting` } });
    }

    const updated = await reviewModel.updateReview(reviewId, { rating, reviewText, photoUrl });
    res.json(updated);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found' } });
    }
    logger.error(`PATCH /reviews/:reviewId: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update review' } });
  }
}

// ---------------------------------------------------------------------
// GET /restaurants/:restaurantId/reviews — public, no auth. Transparency
// as a lived value (product-vision), not just an internal metric.
// ---------------------------------------------------------------------
export async function listPublic(req, res) {
  const { restaurantId } = req.params;
  const mealId = typeof req.query.meal_id === 'string' ? req.query.meal_id : null;

  try {
    const reviews = await reviewModel.findPublicReviews(restaurantId, mealId);
    res.json({ data: reviews });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Restaurant not found' } });
    }
    logger.error(`GET /restaurants/:restaurantId/reviews: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to load reviews' } });
  }
}

// ---------------------------------------------------------------------
// POST /restaurants/:restaurantId/reviews/:reviewId/responses —
// reply_to_review (manager/owner/system_admin).
// ---------------------------------------------------------------------
export async function respond(req, res) {
  const { restaurantId, reviewId } = req.params;
  const { response_text: responseText } = req.body;

  try {
    const review = await reviewModel.findReviewById(reviewId);
    if (!review || review.restaurant_id !== restaurantId) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found' } });
    }

    const response = await reviewModel.insertResponse(reviewId, req.actor.id, responseText);
    res.status(201).json(response);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found' } });
    }
    logger.error(`POST /restaurants/:restaurantId/reviews/:reviewId/responses: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to post response' } });
  }
}

// ---------------------------------------------------------------------
// PATCH /restaurants/:restaurantId/reviews/:reviewId/moderate —
// moderate_review (owner/system_admin) — approve (is_public: true) or
// remove (is_public: false) a review.
// ---------------------------------------------------------------------
export async function moderate(req, res) {
  const { restaurantId, reviewId } = req.params;
  const { is_public: isPublic } = req.body;

  try {
    const review = await reviewModel.findReviewById(reviewId);
    if (!review || review.restaurant_id !== restaurantId) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found' } });
    }

    const updated = await reviewModel.setReviewVisibility(reviewId, isPublic);
    res.json(updated);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Review not found' } });
    }
    logger.error(`PATCH /restaurants/:restaurantId/reviews/:reviewId/moderate: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to moderate review' } });
  }
}
