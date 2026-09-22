import { pool } from '../db.js';

export async function insertSuggestion(data, executor = pool) {
  const result = await executor.query(
    `INSERT INTO feature_suggestions (title, description, category, created_by_guest_id, created_by_staff_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, title, description, category, upvote_count, is_implemented, status, created_at`,
    [data.title, data.description ?? null, data.category ?? 'both', data.createdByGuestId ?? null, data.createdByStaffId ?? null]
  );
  return result.rows[0];
}

/** Public roadmap listing — the whole point of this table (product-vision: "a public roadmap"). */
export async function findAll(statusFilter, executor = pool) {
  const result = await executor.query(
    `SELECT id, title, description, category, upvote_count, is_implemented, implemented_date, status, created_at
     FROM feature_suggestions
     WHERE $1::text IS NULL OR status = $1
     ORDER BY upvote_count DESC, created_at DESC`,
    [statusFilter ?? null]
  );
  return result.rows;
}

export async function findById(suggestionId, executor = pool) {
  const result = await executor.query(`SELECT id, status FROM feature_suggestions WHERE id = $1`, [suggestionId]);
  return result.rows[0] ?? null;
}

/**
 * Records a vote and increments upvote_count in one transaction — ON
 * CONFLICT DO NOTHING against the schema's own partial unique indexes
 * (unique_guest_vote_per_suggestion / its staff equivalent) makes a
 * repeat vote a silent no-op rather than a 500 from a raw constraint
 * violation, and the RETURNING clause is how the caller tells "voted"
 * from "already had voted" apart without a second query.
 * @returns {Promise<boolean>} true if this was a new vote, false if the voter had already voted.
 */
export async function castVote({ suggestionId, guestProfileId, staffId }, client) {
  const result = await client.query(
    `INSERT INTO suggestions_votes (suggestion_id, voted_by_guest_id, voted_by_staff_id)
     VALUES ($1, $2, $3)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [suggestionId, guestProfileId ?? null, staffId ?? null]
  );
  if (result.rows.length === 0) {
    return false;
  }
  await client.query(`UPDATE feature_suggestions SET upvote_count = upvote_count + 1 WHERE id = $1`, [suggestionId]);
  return true;
}

export async function setRoadmapStatus(suggestionId, status, executor = pool) {
  const isImplemented = status === 'completed';
  const result = await executor.query(
    `UPDATE feature_suggestions
     SET status = $1, is_implemented = $2, implemented_date = CASE WHEN $2 THEN CURRENT_DATE ELSE implemented_date END, updated_at = CURRENT_TIMESTAMP
     WHERE id = $3
     RETURNING id, status, is_implemented, implemented_date`,
    [status, isImplemented, suggestionId]
  );
  return result.rows[0];
}
