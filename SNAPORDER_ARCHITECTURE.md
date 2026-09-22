# SnapOrder — Architecture

Companion to `SNAPORDER_DATABASE_SCHEMA.md` (full schema), `SNAPORDER_API_CONTRACTS.md` (endpoints), and `SNAPORDER_AUTHORIZATION.md` (RBAC/ABAC/IAM/PAM model). This file is the shape of the system; those are the detail. Update the diagrams here when a real architectural piece changes (a new service, a new client, a queue actually gets wired in) — not for every new endpoint or table, which belong in the docs above instead.

Last updated: 2026-09-21

---

## High-level architecture

```mermaid
flowchart LR
    subgraph Clients
        GuestApp["Guest Web App (React/Vite)<br/>QR scan → menu → cart → checkout → order status<br/>✅ built"]
        StaffApp["Staff App<br/>KDS UI, serve/mark ready<br/>❌ not built"]
        AdminApp["Admin Dashboard<br/>analytics, menu editor, order mgmt<br/>❌ not built"]
    end

    subgraph Backend["SnapOrder API — Express modular monolith (/v1)"]
        REST["REST API"]
        Realtime["Socket.io realtime<br/>rooms: table:*, kitchen:*, staff:*"]
    end

    DB[("PostgreSQL<br/>single source of truth")]
    Redis[("Redis<br/>declared dependency,<br/>not yet wired into any code path")]
    RabbitMQ[("RabbitMQ<br/>declared dependency,<br/>not yet wired into any code path")]
    Paystack["Paystack<br/>payments (order- and bill-level)"]
    EmailProvider["Email/SMS provider<br/>NOT integrated — password-reset<br/>tokens are generated correctly but<br/>only logged, never delivered"]
    S3["AWS S3<br/>planned for meal images —<br/>not yet integrated"]

    GuestApp -->|HTTPS/JSON, Bearer JWT| REST
    GuestApp <-->|WebSocket, same JWT| Realtime
    StaffApp -.->|planned| REST
    StaffApp -.->|planned| Realtime
    AdminApp -.->|planned| REST

    REST --> DB
    Realtime --> DB
    REST -->|initialize + webhook| Paystack
    REST -.->|planned| EmailProvider
    REST -.->|planned| S3
    REST -.->|planned: shared rate-limit store| Redis
    REST -.->|planned: async, non-critical-path work| RabbitMQ
```

**Why Redis/RabbitMQ are dashed:** both are real Docker services in `docker-compose.yml` and real npm dependencies, but no code path actually uses either one yet. Rate limiting (`middleware/rateLimit.js`) is in-memory today — fine for one instance, and Redis is the documented upgrade path *if* this ever runs as more than one. Nothing currently needs an async queue; `engineering-practices` calls for RabbitMQ over synchronous calls for non-critical-path work (notifications, emails) once that work exists. Don't remove either from `docker-compose.yml` on the assumption they're unused — they're provisioned ahead of the features that will need them.

**Single deployable unit:** frontend and backend are separate apps (separate Dockerfiles, separate origins in dev), but the backend itself is one Express process — a deliberate modular monolith (`engineering-practices`), not microservices. Split into services only when there's a concrete, proven need (independent scaling, genuinely distinct hardware profiles), not speculatively.

---

## Low-level architecture — request pipeline

```mermaid
flowchart TB
    Req["Incoming HTTP request"] --> Helmet["helmet()<br/>security headers"]
    Helmet --> CORS["cors()<br/>origin allowlist (CORS_ORIGIN)"]
    CORS --> RateLimit["generalLimiter<br/>300 req/15min/IP"]
    RateLimit --> WebhookCheck{"/v1/payments/webhook ?"}
    WebhookCheck -->|yes — raw body preserved| WebhookSig["HMAC-SHA512 signature check<br/>IS the auth for this route"]
    WebhookCheck -->|no| JSONParse["express.json()"]
    JSONParse --> RouteMatch["Route match"]

    RouteMatch --> GuestOrStaff{"Guest-facing<br/>or staff-facing?"}
    GuestOrStaff -->|guest| AuthGuest["authenticateGuest<br/>verify JWT + live guest_sessions row<br/>(sitting_id, expiry, revocation)"]
    GuestOrStaff -->|staff| Authenticate["authenticate<br/>verify JWT + live users row"]

    Authenticate --> Authorize["authorize(permission)<br/>1 restaurant_staff row exists (ownership)<br/>2 is_active<br/>3 role grants permission<br/>4 optional ABAC condition<br/>→ every denial audit-logged"]
    AuthGuest --> Controller["Controller"]
    Authorize --> Controller

    Controller --> Model["Model layer<br/>parameterized SQL, transactions<br/>where multiple writes must be atomic"]
    Model --> DB[("PostgreSQL")]
    Controller -.->|best-effort, never fails the HTTP response| Emit["Realtime emit"]
```

**Route file styles, by history, not by current preference:** the controller/model split (`routes/ → controllers/ → models/`) is the default for anything new; five legacy route files (`auth.js` for register/login, `staff.js`, `guestSession.js`, `restaurantOrders.js`, `tables.js`) stay flat (query `pool` directly) because touching them wasn't asked for when the split became the default — not because flat is still preferred. `routes/auth.js`'s newer endpoints (refresh, reset, MFA) followed the split for their persistence (`models/authModel.js`) while keeping the route handlers themselves inline, consistent with how that file already worked.

---

## Identity types and their enforcement paths

Three distinct identity types, each with its own token type and its own middleware — deliberately never sharing a code path (see `SNAPORDER_AUTHORIZATION.md` Part 0 and 4):

| Identity | Token | Middleware | Backed by |
|---|---|---|---|
| Guest | JWT, `type: 'guest'`, short-lived (4h) | `authenticateGuest` | `guest_sessions` row (proximity-gated at issuance, re-verified every 3 min via heartbeat) |
| Staff | JWT, minimal (`sub` only) | `authenticate` + `authorize(permission)` | `users` + `restaurant_staff` (role resolved fresh every request, never trusted from the token) |
| System Admin | Same staff JWT | `authenticate` + `requirePlatformAdmin(permission)` | `platform_admins` (separate table, not a `restaurant_staff` role) |

A fourth, short-lived token type exists purely as an interstitial step: an MFA challenge (`type: 'mfa_challenge'`, 5 min) issued by `/login` when `users.mfa_enabled` is true, redeemed by `/mfa/verify-login` for a real access+refresh pair. It can't be used anywhere else — `authenticate`/`authenticateGuest` both reject a token whose `type` doesn't match what they expect.

Refresh tokens (`refresh_tokens` table) are opaque, DB-backed, and rotated on every use — closer in spirit to a session row than a JWT, for the same reason `guest_sessions` is a real row: revocation (logout, a password reset) has to take effect immediately, which a purely stateless long-lived token could never do.

---

## Domain entities, grouped by concern

Full column-level detail lives in `SNAPORDER_DATABASE_SCHEMA.md` — this is the map, not the territory.

- **Identity/access:** `users`, `restaurant_staff`, `platform_admins`, `refresh_tokens`, `password_reset_tokens`, `audit_log`
- **Restaurant setup:** `restaurants`, `tables`, `menus`, `meal_categories`, `meals`, `ingredients`, `meal_ingredients`, `meal_addons`, `shifts`, `table_assignments`
- **Guest identity:** `guest_profiles` (per-restaurant, phone-keyed), `guest_sessions` (per-visit, proximity-gated), `guest_visits` (schema exists, not yet populated — see `SNAPORDER_STATUS.md`)
- **Ordering:** `table_sittings`, `orders`, `order_items`
- **Billing/payments:** `bills`, `bill_splits`, `bill_split_shares`, `payment_transactions`, `staff_calls`
- **Feedback (schema only, zero routes):** `guest_reviews`, `restaurant_responses`, `feature_suggestions`, `suggestions_votes`

---

Related: `SNAPORDER_STATUS.md` (what's actually built vs. planned, and the phased roadmap), `SNAPORDER_DATABASE_SCHEMA.md`, `SNAPORDER_API_CONTRACTS.md`, `SNAPORDER_AUTHORIZATION.md`.
