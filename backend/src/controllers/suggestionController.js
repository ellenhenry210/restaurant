import { z } from 'zod';

import { pool } from '../db.js';
import * as suggestionModel from '../models/suggestionModel.js';
import { logger } from '../logger.js';

const ROADMAP_STATUSES = ['proposed', 'planned', 'in_progress', 'completed'];

export const createSuggestionSchema = z.object({
  title: z.string().min(1, 'required'),
  description: z.string().optional(),
  category: z.enum(['guest', 'restaurant', 'both']).optional(),
});

export const setRoadmapStatusSchema = z.object({
  status: z.enum(ROADMAP_STATUSES, { message: `status must be one of: ${ROADMAP_STATUSES.join(', ')}` }),
});

// ---------------------------------------------------------------------
// POST /suggestions — guest-created. No "create_suggestion" permission
// exists in the matrix (only vote_suggestion/set_roadmap_status do) —
// the schema itself (created_by_guest_id/created_by_staff_id) already
// anticipated open creation by either identity type; this is that,
// split into two routes (this one for guests, the restaurant-scoped one
// below for staff) since there's no single middleware that accepts
// either a guest or a staff token.
// ---------------------------------------------------------------------
export async function createByGuest(req, res) {
  const { title, description, category } = req.body;
  try {
    const suggestion = await suggestionModel.insertSuggestion({
      title,
      description,
      category,
      createdByGuestId: req.guestSession.guest_profile_id,
    });
    res.status(201).json(suggestion);
  } catch (err) {
    logger.error(`POST /suggestions: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create suggestion' } });
  }
}

// POST /restaurants/:restaurantId/suggestions — staff-created. Any
// active staff role, no specific permission gate (see doc comment above
// — none is defined for creation, only for voting/roadmap-setting).
export async function createByStaff(req, res) {
  const { title, description, category } = req.body;
  try {
    const suggestion = await suggestionModel.insertSuggestion({
      title,
      description,
      category,
      createdByStaffId: req.actor.id,
    });
    res.status(201).json(suggestion);
  } catch (err) {
    logger.error(`POST /restaurants/:restaurantId/suggestions: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to create suggestion' } });
  }
}

// ---------------------------------------------------------------------
// GET /suggestions — public roadmap listing, no auth (product-vision:
// "a public roadmap" as a lived transparency value).
// ---------------------------------------------------------------------
export async function list(req, res) {
  const statusFilter = typeof req.query.status === 'string' ? req.query.status : null;
  try {
    const suggestions = await suggestionModel.findAll(statusFilter);
    res.json({ data: suggestions });
  } catch (err) {
    logger.error(`GET /suggestions: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to list suggestions' } });
  }
}

async function vote(req, res, voterIds) {
  const { id } = req.params;
  try {
    const suggestion = await suggestionModel.findById(id);
    if (!suggestion) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } });
    }

    const client = await pool.connect();
    let isNewVote;
    try {
      await client.query('BEGIN');
      isNewVote = await suggestionModel.castVote({ suggestionId: id, ...voterIds }, client);
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }

    res.status(isNewVote ? 201 : 200).json({ voted: true, already_voted: !isNewVote });
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } });
    }
    logger.error(`vote on suggestion: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to record vote' } });
  }
}

// POST /suggestions/:id/vote — guest vote. Idempotent — voting twice
// isn't an error, it just doesn't count a second time (see castVote).
export async function voteAsGuest(req, res) {
  if (!req.guestSession.guest_profile_id) {
    // suggestions_votes requires a non-null guest/staff id (its own
    // chk_vote_single_voter constraint) — a session with no linked
    // guest_profile yet (hasn't placed an order this visit) has nothing
    // to attribute a vote to. Fail with a clear message rather than
    // letting the DB constraint reject it as an opaque 500.
    return res.status(409).json({
      error: { code: 'CONFLICT', message: 'Place an order before voting, so your vote can be attributed to you' },
    });
  }
  return vote(req, res, { guestProfileId: req.guestSession.guest_profile_id });
}

// POST /restaurants/:restaurantId/suggestions/:id/vote — staff vote
// (vote_suggestion — waiter/kitchen_staff/manager/owner per the matrix).
export async function voteAsStaff(req, res) {
  return vote(req, res, { staffId: req.actor.id });
}

// ---------------------------------------------------------------------
// PATCH /suggestions/:id/roadmap-status — set_roadmap_status, System
// Admin only (the one row in the matrix where system_admin is granted
// and every restaurant-scoped role, including guest, is not).
// ---------------------------------------------------------------------
export async function setRoadmapStatus(req, res) {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const suggestion = await suggestionModel.findById(id);
    if (!suggestion) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } });
    }
    const updated = await suggestionModel.setRoadmapStatus(id, status);
    res.json(updated);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Suggestion not found' } });
    }
    logger.error(`PATCH /suggestions/:id/roadmap-status: failed: ${err.message}`);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update roadmap status' } });
  }
}
