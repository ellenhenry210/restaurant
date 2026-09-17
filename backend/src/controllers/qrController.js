import QRCode from 'qrcode';

import * as qrModel from '../models/qrModel.js';

// Falls back to the production domain the guest app will eventually live
// at; overridable per-environment (e.g. a staging URL) via env var.
const GUEST_APP_BASE_URL = process.env.GUEST_APP_BASE_URL || 'https://snaporder.app';

// ---------------------------------------------------------------------
// GET /v1/qr/:restaurantId/:tableNumber — returns a PNG QR code image for
// a table, generated on the fly (no image storage/CDN is configured —
// AWS_S3_* in .env.example are still placeholders — so this renders fresh
// per request rather than caching a hosted file).
//
// Deliberate deviation from the literal spec this was requested against
// (`https://snaporder.app/?r=restaurantId&t=tableNumber`): that scheme
// encodes the table_number directly, and table numbers are small
// sequential integers — trivially enumerable (t=1, t=2, t=3...). The QR
// here encodes tables.qr_code_unique_id instead (migration 001's random,
// per-table token, already the target of the tested proximity-gated
// POST /v1/tables/:qrCodeId/scan flow) so a table's guest entry point
// can't be guessed from another table's. restaurantId/tableNumber are
// still in THIS endpoint's own URL, but that's fine here — this route is
// staff-only (manage_tables), used to look up and print a table's code,
// not the guest-facing link itself.
// ---------------------------------------------------------------------
export async function getTableQr(req, res) {
  const { restaurantId, tableNumber } = req.params;
  const tableNumberInt = Number(tableNumber);

  if (!Number.isInteger(tableNumberInt) || tableNumberInt < 1) {
    return res.status(400).json({ error: { code: 'INVALID_REQUEST', message: 'tableNumber must be a positive integer' } });
  }

  try {
    const table = await qrModel.findTableByNumber(restaurantId, tableNumberInt);
    if (!table) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Table not found' } });
    }

    const targetUrl = `${GUEST_APP_BASE_URL}/scan?code=${table.qr_code_unique_id}`;

    // "Store QR metadata in database" — the deep link this QR encodes,
    // kept in sync on tables.qr_code_url. Deterministic (derived from the
    // table's own stable qr_code_unique_id), so this is a cheap idempotent
    // write, not a growing history.
    if (table.qr_code_url !== targetUrl) {
      await qrModel.saveQrCodeUrl(table.id, targetUrl);
    }

    const png = await QRCode.toBuffer(targetUrl, { type: 'png', margin: 2, width: 400 });
    res.set('Content-Type', 'image/png');
    res.send(png);
  } catch (err) {
    if (err.code === '22P02') {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Restaurant not found' } });
    }
    console.error('GET /qr/:restaurantId/:tableNumber: failed:', err.message);
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to generate QR code' } });
  }
}
