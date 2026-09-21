-- 012_guest_session_heartbeat.sql
--
-- Closes a real gap in the proximity requirement: guest_sessions
-- (migration 003) only ever checked distance once, at scan time
-- (POST /v1/tables/:qrCodeId/scan). Nothing re-checked it afterwards, so
-- a guest who scanned while present, then left, kept full ordering/
-- payment access for the rest of the 4-hour token. The frontend now
-- polls a heartbeat endpoint periodically (RequireGuestSession.jsx);
-- these columns track the most recent check separately from the
-- original scan_* columns, which stay as the historical entry record.

ALTER TABLE guest_sessions
  ADD COLUMN last_checked_at TIMESTAMP,
  ADD COLUMN last_latitude DECIMAL(9, 6),
  ADD COLUMN last_longitude DECIMAL(9, 6),
  ADD COLUMN last_distance_meters DECIMAL(10, 2);

ALTER TABLE guest_sessions
  ADD CONSTRAINT chk_guest_sessions_last_lat CHECK (last_latitude IS NULL OR last_latitude BETWEEN -90 AND 90),
  ADD CONSTRAINT chk_guest_sessions_last_lon CHECK (last_longitude IS NULL OR last_longitude BETWEEN -180 AND 180);

-- A session revoked for drifting out of range is a real, audit-worthy
-- event (SNAPORDER_AUTHORIZATION.md Part 5) distinct from the existing
-- action types, so it needs its own entry in the CHECK constraint rather
-- than being shoehorned into 'authz_denied' (that one's specifically for
-- RBAC/ABAC authorize() denials, a different mechanism entirely).
ALTER TABLE audit_log DROP CONSTRAINT chk_audit_action;
ALTER TABLE audit_log ADD CONSTRAINT chk_audit_action CHECK (action IN (
  'order_placed', 'order_cancelled', 'menu_updated',
  'inventory_updated', 'review_posted', 'staff_login',
  'authz_denied', 'guest_session_revoked'
));
