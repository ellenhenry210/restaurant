# SnapOrder — Project Status

Living status file. Update this as work progresses — move items between
sections rather than letting it drift out of sync with the code.

Last updated: 2026-09-22 (later still)

See also `SNAPORDER_ARCHITECTURE.md` for the high-/low-level architecture diagrams.

---

## ✅ Done and verified

**Backend core**
- Auth (staff login/register), full RBAC+ABAC (`authorize()` middleware, permission matrix, audit-logged denials), JWT with immediate deprovisioning effect
- Guest identity: proximity-gated QR scan (Haversine, fails closed), now with continuous re-verification (heartbeat every 3 min — closes the "scan then leave" gap)
- Full order lifecycle: place → allergen removal-policy engine (can/caution/cannot-remove) → staff/kitchen status transitions → tax/tip/service-charge math
- Real-time Kitchen Display System (Socket.io, broadcast-only, room-based)
- Table-level billing system: sittings, one consolidated bill by default, explicit split (even/custom) with enforced pay-per-share once split, three payment timings (pay now/after/traditional), Pay-Traditionally staff-call flow with realtime notification
- Payments: Paystack integration (order-level and bill-level), webhook with HMAC verification
- QR generation, staff management, table assignment, meal/menu CRUD, daily + revenue-period + platform-level analytics
- `cancel_order` for guests (self-service, before the kitchen starts on it)
- Feedback & Suggestions system — guest reviews (leave/edit within 48h) with staff replies/moderation, the public feature-suggestion roadmap (create/vote/system-admin status-setting), all schema-backed since day one, zero routes until now
- Guest order history (`GET /guest/session/history`) + repeat-guest recognition (`is_returning_guest`/`visit_count` on `GET /guest/session`) — and the `guest_visits` wiring underneath it, previously a "kept for later" schema-only gap
- Inventory writes — meal availability toggle (`mark_out_of_stock`) and ingredient stock levels (`set_inventory_levels`/`view_inventory`), both audit-logged
- Refunds (`issue_refund`, real Paystack refund API call) and a payment-history view (`view_payment_history`) — new `refunded` states added to both `bills` and `payment_transactions`
- Basic rule-based meal recommendations (guest-facing) — filters on a meal's existing dietary tags, ranked by real order-frequency popularity. The restaurant-facing "chef suggestion engine" stays out of scope — it needs demand/margin data this project doesn't have, and is correctly Phase 3, not attempted here.

**Frontend**
- Full guest ordering flow: QR scan → menu browse → cart → checkout → order status (with live socket updates + Pay with Paystack)
- White-label theming applied at render (restaurant colors/name)
- Guest billing UI (`/bill`) — timing picker (pay now/after/traditional), live totals, even-split request + per-share pay, settled/staff-called banners. Linked from the order status page ("View table bill") alongside the existing per-order Paystack button.
- Staff app shell — separate staff identity/session (`StaffAuthProvider`, own axios client, own JWT — never shares state with the guest session), login page with full TOTP MFA step, route guard, nav layout
- Kitchen Display System UI (`/staff/kitchen`) — real-time item-level queue (pending/preparing/ready columns), hydrates via REST on load then stays live via `new_order`/`item_status_updated` socket events
- Staff Orders page (`/staff/orders`) — order-level status advancement (`placed→confirmed→preparing→ready→served`, cancel) plus the Pay-Traditionally "waiter calls" inbox (acknowledge/resolve), live via `new_order`/`order_status_updated`/`waiter_called`
- Admin dashboard (`/staff/admin`) — four tabs, all against real endpoints: Analytics (daily + 7-day revenue chart), Menu (availability toggle + create-meal form, now shows previously-invisible out-of-stock meals), Inventory (stock level edit), Payments (transaction history + refund button)
- Fixed a real pre-existing bug found while wiring this batch in: `CartProvider` was defined but never mounted in `main.jsx` — `useCart()` (Menu/Cart/Checkout pages) would have thrown at runtime the instant any of them rendered, in every build before this one.

**Testing/CI/CD**
- 173 backend tests (unit + integration, 27 test suites), all green — verified via a full `npm test` run, not estimated (this file is a snapshot, not live state — re-verify before trusting an exact count later)
- Frontend: `npm run lint` and `npm run build` both clean for this batch. All new pages' backend calls were verified against the running dev server via direct HTTP requests (registered a real test restaurant, seeded a menu/meal/table, placed real guest orders, drove every button's underlying endpoint — status advances, item advances, availability toggle, ingredient stock, refund route, split request, staff-call acknowledge/resolve) — this is real request/response verification, not just code reading. **What this batch could not do: an actual in-browser visual check.** The Claude-in-Chrome extension was not connected this session, so the UI itself (layout, click targets, socket updates rendering live in a real page) has not been eyeballed — only its API contracts have. Treat the four frontend surfaces below as functionally verified, not visually verified, until someone opens them in a browser.
- GitHub Actions: lint → test → audit → build → publish images to ghcr.io on main
- Production Dockerfiles for both apps

**Security fixes shipped**
- Rate limiting, centralized error handling, audit-log FK bug fix, npm vulnerability cleanup, guest session heartbeat
- CORS (origin allowlist) + `helmet` security headers
- Structured logging (`winston`) — replaced all 63 `console.*` call sites across the backend, JSON in production, silenced in tests
- QR code rotation (`POST /v1/qr/:restaurantId/:tableNumber/rotate`, invalidates the old code immediately) + optional per-restaurant max-age expiry policy
- Refresh tokens — opaque, DB-backed, rotated on every use, revocable (logout, password reset)
- Password reset flow — request/reset endpoints, single-use tokens, revokes all sessions on reset. **Real gap inside this "done": no email/SMS provider is wired up, so the reset token is generated correctly but only logged server-side, never actually delivered to the guest/staff member.** The mechanism is real; delivery is not.
- MFA (TOTP) for Owner/System Admin accounts — setup/verify-setup/verify-login/disable, gated to Owner + System Admin only (PAM requirement), disable requires both password and a valid code
- Input validation (`zod`) — a `validate(schema)` middleware replacing every hand-rolled `validateXInput` function across the backend: all of `auth.js` (register/login/refresh/logout/forgot-password/reset-password/mfa endpoints), `guestSession.js` (scan/heartbeat), order creation, bill creation/split-request, meal creation, staff add/update, table assignment, order/item status transitions. Closed two real pre-existing testing gaps found along the way: `staff.js` and `tables.js` had zero tests before this — both now have coverage.
- Distributed rate limiting — Redis-backed (`rate-limit-redis`, real running Redis, not just a declared dependency) with automatic in-memory fallback if Redis is unreachable. Skips Redis entirely under `NODE_ENV=test` — it's real shared external state, so a test run's own counters would otherwise accumulate across every test file, not reset per-file.
- Password reset email delivery — `src/notifications.js`, plain SMTP via `nodemailer` (works with SendGrid/Postmark/Mailgun/SES/etc. — no vendor lock-in), wired into `forgot-password`. Falls back to a log line if `SMTP_HOST` isn't configured (still the default — no real credentials exist yet).
- Guest phone verification (OTP) — new, previously-unflagged gap closed: a guest could claim any phone number with nothing checking it. `POST /guest/verify-phone/{request,confirm}`, hashed 6-digit codes, attempt-limited, 10-minute expiry. **Mechanism only — deliberately not enforced anywhere yet** (would add friction to the guest checkout flow; enforcing it is a product decision, not a security-pass side effect).
- Dependabot (`.github/dependabot.yml`) — continuous dependency-vulnerability monitoring (backend npm, frontend npm, GitHub Actions), closing the gap where `npm audit` only ever ran at a point in time (a manual pass, or CI on push) rather than watching for newly-disclosed CVEs in between.
- Security review performed on this entire batch — one confirmed finding (password-reset tokens and OTP codes logged in plaintext as the delivery fallback) fixed the same session: secrets are now only logged under `NODE_ENV=development`, never in test/production, where a non-secret "delivery didn't happen" message is logged instead.
- GitHub remote credential cleanup — this repo's `origin` URL had a personal access token embedded in plaintext; stripped to a clean `https://github.com/...` URL (Git Credential Manager, already configured, handles auth from here). **Root cause was actually in *global* git config** (a `url.<token>@github.com/.insteadOf` rewrite rule affecting every repo on the machine, plus a second, unexplained token under a different GitHub username) — the user chose not to have that touched; exact removal commands were handed off instead. Both tokens still need revoking on GitHub itself, which only the user can do.
- `PATCH /staff-calls/:callId` converted to the `validate(schema)` zod pattern — found 2026-09-22 while answering "has this been properly hardened": it was the one write endpoint still on the old hand-rolled check after every other route moved to `validate()`. Not a vulnerability on its own (the old check was still correct), just an inconsistency — closed for real coverage, not just documented.
- `GET /v1/bills/:billId/splits` fixed — `findSharesBySplit` ordered by a `created_at` column `bill_split_shares` has never had, 500ing every call. Zero test coverage had ever exercised this endpoint (every existing split test only ever called the POST). Found manually while hand-verifying the new `BillPage.jsx` split UI against the real API; fixed (`ORDER BY guest_label` instead) and two regression tests added in `bills.test.js`.

---

## 🛡️ Hardening assessment (as of 2026-09-22 — answer to "has SnapOrder been properly hardened?")

Short answer: **no, not as a whole system** — application-layer security is genuinely solid and test-backed; infrastructure-layer hardening doesn't exist because no infrastructure has been deployed yet; and a data-protection stance has never been decided. Don't let "the security batch is done" (above) get read as "SnapOrder is hardened" — they're different claims. Breaking it down by layer:

**Solid — backed by a passing test, not just a comment:**
RBAC+ABAC with audit logging, JWT + refresh-token rotation, MFA (TOTP, PAM-gated), input validation (zod) across every write endpoint, CORS/helmet, Redis-backed rate limiting, structured logging with secrets excluded from non-dev logs, a real code-security review of everything built in this session (one finding, fixed), continuous dependency monitoring (Dependabot).

**Partially hardened — a real gap lives inside the "done":**
- Password reset and phone verification are real mechanisms with no delivery channel connected (no SMTP/SMS credentials).
- Two GitHub PATs are still live and unrevoked (one exposed in this repo's git config, a second, unexplained one under a different GitHub username, found in global git config) — revoking either requires the user's own GitHub account access.
- Today's security review covered only the code written in this session. **It is not a substitute for a real third-party penetration test, which has never happened for this project.**

**Not hardened at all — because the thing it would harden doesn't exist yet:**
- No deployment target exists (CI publishes Docker images, nothing runs them) — so there is no TLS termination, network segmentation, secrets vault, log aggregation/alerting, DDoS protection, or backup/disaster-recovery plan to evaluate. This isn't a gap to close with more code; it has no target until a hosting decision is made.
- No data-protection/compliance posture for a consumer app storing guest phone numbers, targeting Nigeria specifically — no documented NDPR (Nigeria Data Protection Regulation) stance, no PII retention or deletion policy. Never raised before this note; worth a deliberate decision rather than defaulting into one.

---

## 🕐 Kept for later (deliberately scoped out, not forgotten)

- Itemized/by-item bill splitting — only even/custom-by-amount exist; splitting by specific dish needs richer UI
- What happens to an abandoned `pay_after` bill if the guest's session expires before paying — flagged, no policy decided
- A staff "close sitting" endpoint — a table that never finishes checkout in-app has no manual reset path yet (this is also why two sequential sittings at the same table needed a manual `status = 'closed'` update to test — there's no real mechanism yet)
- Cross-restaurant guest identity — current `guest_profiles` is per-restaurant; true cross-restaurant history (VIP tiers, points spec) needs a platform-level identity layer, explicitly deferred
- Restaurant-facing recommendations ("chef suggestion engine") / predictive analytics — flagged as real gaps, no design started yet; correctly Phase 3 (needs demand/margin data and an ML layer this project doesn't have)
- `frontend/docker-compose.yml` stray duplicate — still awaiting a yes/no to delete it

---

## ❌ Not done / not started at all

**Frontend**
- Custom (by-amount, per-guest) bill splitting has no UI yet — the picker only offers even split; the backend already supports `split_type: 'custom'` with explicit per-share amounts (see 🕐 Kept for later)
- A visual/in-browser QA pass on the four staff+billing UI surfaces just built (KDS, staff orders, admin dashboard, guest bill) — verified functionally against the real API, not yet eyeballed in an actual browser (Claude-in-Chrome wasn't connected this session)

**Backend/product**
- AI meal recommendations, restaurant side ("chef suggestion engine") — see 🕐 Kept for later; the guest side is now built
- No admin API to create a menu or a table — found 2026-09-22 while seeding test data to verify the new admin dashboard UI. `POST /restaurants/:id/meals` exists (create a meal into an existing category), but there's no route to create a menu, a `meal_category`, or a table at all; today these can only be inserted directly via SQL. Not previously flagged because nothing had exercised restaurant onboarding end-to-end before now.

**Security (still open)**
- Real SMTP credentials for password-reset email (mechanism done, needs a real provider account)
- Real SMS provider for guest phone verification (mechanism done, needs Termii/Africa's Talking/Twilio or similar wired into `sendSms`)
- Revoking the two exposed GitHub tokens (see above) — requires the user's GitHub account access
- Removing the global git config entries that re-inject those tokens — user chose to do this manually; commands provided
- A real security audit / third-party penetration test has still never been done — this session's review covered only the code changed today, not the full system

**Infra**
- No actual deployment target — CI publishes images to ghcr.io, nothing runs them anywhere
- No ADRs, LICENSE, or CONTRIBUTING.md
- No infrastructure-layer hardening at all yet (TLS termination, network segmentation, secrets vault, log aggregation/alerting, DDoS protection, backups) — has no target to apply to until a deployment decision is made; see 🛡️ Hardening assessment below

**Compliance**
- No data-protection/compliance stance decided — no documented NDPR (Nigeria Data Protection Regulation) position, no PII retention/deletion policy for guest phone numbers. Never raised before 2026-09-22.

---

## 🎯 Suggested priority order

Security-first per the standing project directive, then closing out work that's already 90% built before starting new large surfaces. Updated 2026-09-22 (later still) — the frontend batch that was the top four items on this list (billing UI, KDS UI, staff app, admin dashboard) is now built and functionally verified. What's left is a real in-browser QA pass on that batch, custom bill-split UI, and the handful of items that need the user's own action (provider credentials, GitHub tokens) rather than more code.

1. **Visual/in-browser QA on the frontend batch just built** — KDS, staff orders, admin dashboard, guest bill page were all verified against the real running API (every button's endpoint driven directly), but never opened in an actual browser this session (Claude-in-Chrome wasn't connected). Do this before treating the batch as fully done.
2. **An actual email/SMS provider** — the password-reset and phone-verification mechanisms are otherwise complete; without this neither can reach a real guest/staff member.
3. **Custom bill-split UI** — the backend already supports `split_type: 'custom'`; only even-split has a picker today.
4. **A "close sitting" endpoint** — the one real backend gap left in the billing model; a table that never finishes checkout in-app has no manual reset.
5. **Revoking the two exposed GitHub tokens** and, if the user chooses, cleaning up the global git config that re-injects them.
6. **AI recommendations, restaurant side ("chef suggestion engine") + predictive analytics** — biggest and least-defined scope; correctly Phase 3, worth waiting on until the above is solid.
7. **A real security audit / third-party penetration test** — has never happened for this project; increasingly worth doing as the surface area grows.

---

## 🗺️ Roadmap (Phase 1-4, given 2026-09-21 — corrected against verified repo state)

**Correction note:** several statuses below were pasted in with markers that don't match what's actually in the repo. Corrected in place, with the discrepancy called out — not silently changed, since it matters *why* each one was wrong.

### Phase 1 (MVP)
- QR + table ordering ✅
- Basic allergy input (CAN/CAUTION/CANNOT engine) ✅
- Kitchen display ✅ **corrected from ⚠️** (2026-09-22, later still) — the real-time backend/socket layer was already done and tested; the UI (`/staff/kitchen`) is now built and functionally verified against the real API. Not yet opened in an actual browser this session (see 🎯 Suggested priority order #1).
- Out-of-stock management ✅ **corrected from ⚠️ gap** — availability toggle now has a real UI in the admin dashboard's Menu tab, including previously-invisible out-of-stock meals (a real gap fixed along the way: `findCategoriesWithMealsByMenu` never surfaced `is_available` meals at all before this).
- Split-billing retrofit ✅ **corrected from 🔲 next** — this was actually built the same day: `table_sittings` → `bills` → `bill_splits`/`bill_split_shares`, three payment timings, staff-call flow, webhook cascade, 20 integration tests. The frontend UI (`/bill`) is now built too — even-split only; custom split still needs a picker (see 🎯 priority list).
- Guest identity capture (minimal guests/guest_visits) ⚠️ **corrected from 🔲 next** — the schema exists (`guest_visits`, migration 013, reusing `guest_profiles` rather than a new table); nothing populates it yet. Schema-done and wired-up are different claims.
- Admin dashboard (orders/inventory/menu, RBAC) ✅ **corrected from ⚠️** (2026-09-22, later still) — RBAC itself was already done and heavily tested; the admin dashboard UI (`/staff/admin`) now exists too, with Analytics/Menu/Inventory/Payments tabs against real endpoints.
- Frontend build (menu, cart, checkout, split-bill UI) ⚠️ **corrected from 🔲 after the two "next" items** — menu browsing, cart, checkout, and now the (even-)split-bill UI are done and in production build. Only custom (by-amount) split still has no UI.

### Phase 2
- Nutritional data layer (calories, macros, GI/GL, sugar) — 🔲 not started
- Simple health profiling — diabetes + weight loss only — 🔲 not started
- Basic AI recommendations — rule-based (health goal + allergy → safe meal) — 🔲 not started
- Guest history used for repeat-order detection, favorite meals — 🔲 not started (blocked on the Phase 1 `guest_visits` wiring above)

### Phase 3
- Full health condition matrix (athletic/muscle gain, heart disease, hypertension, celiac/IBS, general wellness) — 🔲 not started
- Restaurant meal suggestion engine (chef-facing AI combos) — 🔲 not started
- Analytics — health-preference segment only (% diabetic, % weight-loss, menu gap flags) — 🔲 not started

### Phase 4 — VIP, Loyalty & Localization
**Why this is its own phase, not folded into 2-3:** VIP/loyalty, payments infrastructure (wallet), and localization are substantial standalone systems that don't fit inside the health/nutrition + analytics focus of Phases 2-3 without diluting them. These are also explicitly features from the original spec that a simplified plan didn't mention but weren't dropped — kept visible here rather than silently deferred out of the roadmap.

- VIP Card & Tiers (Free/Silver/Gold/Premium, auto-progression) — 🔲 not started
- Wallet System (prepaid balance, auto-charge, tier limits, Paystack/mobile money funding) — 🔲 not started
- Points & Rewards (tier earn rate, milestones, referrals, redemption) — 🔲 not started
- Event-Based Rewards (9 event types) — 🔲 not started
- White-Label & Branding (per-restaurant logo/colors/fonts, custom domains, feature toggles) — ⚠️ partially started: `restaurants.logo_url`/`primary_color`/`secondary_color`/`custom_domain` columns exist and the frontend applies color/name theming at render (`theme.js`); fonts, custom domains, and feature toggles are not built
- Multi-Language (English, Yoruba, Igbo) — 🔲 not started
- Full 8-tab Analytics Dashboard — 🔲 not started (only a daily-analytics endpoint exists today, no dashboard UI at all)
- Location-Based Access (1km geofence QR-scan requirement tied to VIP activation) — ⚠️ the geofence mechanism itself already exists and is more sophisticated than described (Haversine proximity check, configurable per-restaurant radius via `max_guest_distance_meters`, re-verified continuously via the heartbeat) — it just isn't tied to any VIP card concept yet, since VIP doesn't exist.

**Why the corrections matter going forward:** three Phase 1 items were marked further along or further behind than reality in the pasted version. Before trusting a roadmap snapshot like this one for planning, cross-check it against `SNAPORDER_STATUS.md`'s own ✅/❌ sections and the actual code — the same caution as [[external-spec-verification]] for pasted schemas.
