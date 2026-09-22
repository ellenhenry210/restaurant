-- 016_qr_rotation_expiry.sql
--
-- Closes a long-flagged security gap (SNAPORDER_STATUS.md): a leaked or
-- photographed QR code (tables.qr_code_unique_id) never expired or
-- could be invalidated. Two mechanisms, both opt-in/manual rather than
-- forced, since restaurants already have physical QR codes printed and
-- laminated on real tables — an automatic default expiry would silently
-- break scanning for restaurants with no reprint workflow in place:
--
-- 1. Manual rotation (the practical fix for "this code leaked right
--    now") — staff can regenerate a table's token on demand.
-- 2. An optional, per-restaurant max-age policy — off by default
--    (NULL), so nothing changes for a restaurant that doesn't opt in.

ALTER TABLE tables ADD COLUMN qr_rotated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP;

ALTER TABLE restaurants ADD COLUMN qr_max_age_days INT;
ALTER TABLE restaurants ADD CONSTRAINT chk_qr_max_age_days CHECK (qr_max_age_days IS NULL OR qr_max_age_days > 0);
