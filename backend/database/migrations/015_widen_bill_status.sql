-- 015_widen_bill_status.sql
--
-- bills.status was declared VARCHAR(20) in migration 013, but its own
-- CHECK constraint (chk_bill_status) already listed 'settled_traditionally'
-- as a valid value — 22 characters, past the column's own limit. Never
-- caught until the route/controller layer actually tried to write it
-- (a staff resolving a Pay-Traditionally call) — found by an integration
-- test, not in production. Widened to VARCHAR(30), matching this
-- codebase's usual practice of leaving headroom past the longest known
-- value rather than sizing exactly to it.

ALTER TABLE bills ALTER COLUMN status TYPE VARCHAR(30);
