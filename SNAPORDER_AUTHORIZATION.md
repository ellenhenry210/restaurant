# SnapOrder Identity & Access Management (IAM: RBAC + ABAC + PAM)

## Status

**Design specification — not yet implemented in code.** This document formalizes the authorization model that earlier design discussion covered verbally; nothing below existed as a tracked file or database migration before this write-up (2025-09-17). Implementation (middleware, permission matrix in code, schema changes) is separate follow-up work.

## Scope

This is the identity and access backbone for **the entire SnapOrder system** — every resource (menu, inventory, orders, kitchen, payments, analytics, staff, feedback), not a special case scoped to allergen handling. The allergen ingredient-removal policy (Part 3) is one concrete application of this model, not a separate system. IAM is the umbrella: it covers *who someone is* (identity, authentication, lifecycle), *what they're allowed to do* (RBAC + ABAC, Parts 1–2), and *extra controls for the accounts that can do the most damage* (PAM, Part 7).

## Design Philosophy

Three of SnapOrder's core values map directly onto this model:
- **Authorization:** every action a guest or staff member can take is explicitly permitted, never assumed.
- **Integrity:** the rules that decide "can this happen" are enforced consistently everywhere (API, kitchen display, admin panel) — not re-implemented ad hoc per screen.
- **Confidence:** guests and restaurant staff can trust that only the right people can see or change their data — a guest's order, a restaurant's revenue numbers, a kitchen's queue.

The formula that governs every access check:

```
CAN_ACCESS = (identity is authenticated) AND (RBAC role grants the permission) AND (all applicable ABAC conditions are met) AND (if the account is privileged, PAM controls are satisfied)
```

Authentication answers "is this really who they claim to be?" RBAC answers "does this *kind* of user generally get to do this?" ABAC answers "given the *specific* data/time/state involved, is it actually okay right now?" PAM answers "if this is a high-privilege account, are the extra safeguards in place?" All applicable layers must pass.

---

## Part 0: IAM — Identity Lifecycle & Authentication

RBAC/ABAC/PAM (Parts 1, 2, 7) are the *access-control* layer of IAM. IAM itself is broader — it also owns how an identity comes to exist, how it proves itself, and how it's retired.

### Identity, as actually implemented (2026-09-17)

Identity (`users`) and role assignment (`restaurant_staff`) are separate tables, not one — see `SNAPORDER_DATABASE_SCHEMA.md` tables 2 and 19. This is what makes the "Owner (or several, if multi-location)" scope note in Part 1's role table real rather than aspirational: one `users` row (one login) can have multiple `restaurant_staff` rows, one per restaurant they have a role at.

### Identity lifecycle

| Stage | For staff (`users` + `restaurant_staff`) | For guests (`guest_profiles`) |
|---|---|---|
| **Provisioning** | `POST /v1/auth/register` creates a `users` row plus a `restaurant_staff` row with role `owner`, for onboarding a brand-new restaurant. There's no self-signup for any other role yet — adding a Waiter/Kitchen Staff/Manager to an *existing* restaurant (an Owner/Manager action, not public) isn't built. | Created automatically on first order (phone number as identifier) — deliberately low-friction, matching the "scan and order" UX. |
| **Authentication** | `POST /v1/auth/login` → JWT, via `backend/src/routes/auth.js` + `backend/src/auth.js`. `backend/src/middleware/auth.js` (`authenticate`) verifies the token and re-loads the `users` row fresh on every request — see below. | Phone number / session token; no password — see `SNAPORDER_API_CONTRACTS.md` `X-Guest-Phone` header. |
| **Role change** | Owner/Manager updates `restaurant_staff.role`. Every role change should be written to `audit_log`. Not yet built (no route for it). | N/A — guests don't have roles. |
| **Deprovisioning** | `restaurant_staff.is_active = false` for that restaurant. **Partially closed:** `authenticate` re-checks that the `users` row still exists on every request (so a deleted account stops working immediately, not just at token expiry) — but it does NOT check `restaurant_staff.is_active`, since that's restaurant/role-scoped and `authenticate` deliberately doesn't know which restaurant a request concerns (see below). That check belongs to the still-unbuilt `authorize()` layer (Part 4). | Guest identity naturally expires with inactivity; no formal offboarding needed since a phone number carries no standing privilege. |

### Authentication mechanics — implemented

- `backend/src/auth.js` — `generateToken`/`verifyToken`. Tokens are deliberately minimal (`{ sub: userId }` only) — no `role` or `restaurant_id` embedded, so a role change takes effect on the next request rather than only after the token expires.
- `backend/src/routes/auth.js` — `POST /v1/auth/register`, `POST /v1/auth/login`. Login resolves the user's role/restaurant from `restaurant_staff` fresh at login time (not from the token).
- `backend/src/middleware/auth.js` — `authenticate`. Verifies the JWT, then re-loads the `users` row from the database (not just trusting the token payload) and attaches it as `req.user`. This is authentication only — *who* the requester is — not authorization. A companion `authorize(permission)` middleware that checks role/restaurant-scoped permissions (Parts 1–2) against `req.user` is specified in Part 4 below but **not yet built** — right now, `authenticate` alone doesn't stop an authenticated user from any particular action; nothing enforces the permission matrix yet.
- Password storage: `bcryptjs`, async `hash`/`compare` (cost 12) — never the sync variants, which would block the event loop for the ~100ms+ a hash takes.

---

## Part 1: RBAC — Roles

### Role Hierarchy

```
Guest → Waiter → Kitchen Staff → Manager → Owner
                                              ↑
                                    System Admin (platform-level, cross-restaurant)
```

Each restaurant-scoped role (Waiter → Owner) inherits the permissions of the roles below it in the chain; System Admin sits outside any single restaurant and is granted explicitly, not by inheritance.

| Role | Scope | Identified by | Notes |
|------|-------|---------------|-------|
| **Guest** | One table session at one restaurant | Phone number / session token (`guest_profiles`) | No login/password — identity is lightweight by design, matching the "scan and order" UX. |
| **Waiter** | One restaurant | `restaurant_staff.role = 'waiter'` | Front-of-house; helps guests, doesn't touch menu/inventory config. |
| **Kitchen Staff** | One restaurant | `restaurant_staff.role = 'kitchen_staff'` | Fulfills orders; sees allergen/removal policy results, cannot override them. |
| **Manager** | One restaurant | `restaurant_staff.role = 'manager'` | Runs day-to-day operations: menu, inventory, policies, staff scheduling, responds to reviews. |
| **Owner** | One restaurant (or several, if multi-location) | `restaurant_staff.role = 'owner'` | Everything Manager can do, plus billing/subscription and staff hiring/removal. |
| **System Admin** | Entire platform, all restaurants | `platform_admins` (new table, see schema notes) | SnapOrder's own team. Support/moderation/platform ops — not a restaurant employee. |

Note on a schema change from the original draft: the earlier `restaurant_staff.role` enum included `chef` and `inventory_manager`. This doc renames `chef` → `kitchen_staff` (matches the role name used throughout this model) and folds `inventory_manager` into `manager` (the specified 6-role hierarchy doesn't carry a separate inventory role — a manager can delegate inventory permissions to specific staff later via an ABAC grant if that turns out to be needed in practice, but there's no evidence yet that it is, so it's left out rather than added speculatively).

### Permission Matrix

`✅` = allowed by role alone (still subject to ABAC conditions in Part 2) · `➖` = not permitted, no code path should allow it regardless of ABAC.

| Permission | Guest | Waiter | Kitchen Staff | Manager | Owner | System Admin |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| **Menu** — view published menu | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Menu** — edit meals/categories | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Menu** — publish/unpublish menu | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Menu** — delete meal | ➖ | ➖ | ➖ | ➖ | ✅ | ✅ |
| **Inventory** — view stock levels | ➖ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Inventory** — mark ingredient out of stock | ➖ | ➖ | ✅ | ✅ | ✅ | ✅ |
| **Inventory** — set stock quantities / reorder levels | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Inventory** — set ingredient removal policy (allergen rules) | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Orders** — place order | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Orders** — request ingredient removal | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Orders** — view own order | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Orders** — view all restaurant orders | ➖ | ✅ | ✅ | ✅ | ✅ | ✅ |
| **Orders** — cancel order | ✅ (own, before `preparing`) | ✅ | ➖ | ✅ | ✅ | ✅ |
| **Orders** — modify order after placement | ➖ | ✅ | ➖ | ✅ | ✅ | ✅ |
| **Kitchen** — view queue | ➖ | ➖ | ✅ | ✅ | ✅ | ✅ |
| **Kitchen** — update item status (preparing/ready) | ➖ | ➖ | ✅ | ✅ | ✅ | ✅ |
| **Kitchen** — flag allergen/prep issue | ➖ | ➖ | ✅ | ✅ | ✅ | ✅ |
| **Kitchen** — override a `cannot_remove` allergen policy | ➖ | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Payment** — pay for own order | ✅ | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Payment** — process/reconcile payment | ➖ | ✅ | ➖ | ✅ | ✅ | ✅ |
| **Payment** — issue refund | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Payment** — view payment history | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Analytics** — view own restaurant's dashboard | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Analytics** — view cross-restaurant platform analytics | ➖ | ➖ | ➖ | ➖ | ➖ | ✅ |
| **Staff** — view staff list | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Staff** — assign shifts | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Staff** — hire/remove staff | ➖ | ➖ | ➖ | ➖ | ✅ | ✅ |
| **Staff** — view individual performance | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Staff** — assign a table to a server (`assign_table`, added 2026-09-17) | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Staff** — generate/print a table's QR code (`manage_tables`, added 2026-09-17) | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Feedback** — leave a review | ✅ (own completed order) | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Feedback** — edit own review | ✅ (within 48h) | ➖ | ➖ | ➖ | ➖ | ➖ |
| **Feedback** — reply to a review publicly | ➖ | ➖ | ➖ | ✅ | ✅ | ✅ |
| **Feedback** — vote on a feature suggestion | ✅ | ✅ | ✅ | ✅ | ✅ | ➖ |
| **Feedback** — approve/remove a review (abuse, spam) | ➖ | ➖ | ➖ | ➖ | ✅ | ✅ |
| **Suggestions** — set roadmap status (planned/in progress/done) | ➖ | ➖ | ➖ | ➖ | ➖ | ✅ |

This matrix lives as a static constant in application code (`backend/src/authorization/permissions.js`), not a database table — consistent with starting as a modular monolith rather than building a dynamic permissions engine before there's a proven need for restaurants to customize roles themselves. `assign_table` is the first permission added to this matrix after the fact (2026-09-17) rather than being part of the original design — an explicit user request ("the guest should know the staff that is assigned to serving them"), given the same role set as the closely related `assign_shifts` since it's the same kind of day-to-day scheduling decision. `manage_tables` (also 2026-09-17, QR code generation) got the same role set for the same reason — a table-setup action, not something a Waiter or Kitchen Staff member does themselves.

**Role naming, addressed directly (2026-09-17):** a request to build admin endpoints named the roles "Owner, Manager, Chef, Cashier." "Chef" was already renamed to `kitchen_staff` earlier in this project specifically to match this 6-role hierarchy; "Cashier" isn't modeled at all, and nothing described for it isn't already covered by an existing role's permissions (`process_payment` is already granted to waiter/manager/owner). No 5th role was added — the three requested admin endpoints were built against the roles above instead of forking a second, inconsistent role system alongside this one.

---

## Part 2: ABAC — Conditions

RBAC grants a *type* of access; ABAC checks whether the *specific* request is actually allowed given real data. Five condition types recur across the system:

### 1. Data ownership (`restaurant_id` scoping)

The single most important rule in the system: **every restaurant-scoped role can only touch rows belonging to their own `restaurant_id`.**

```
manager.restaurant_id === resource.restaurant_id
```

A manager at Restaurant A who is somehow granted a valid session can never view Restaurant B's orders, inventory, staff, or analytics, even though "Manager" the role has the `view_analytics` permission generally. This should be enforced at the query layer (every query scoped by `restaurant_id`, never trusted from the client), not just checked once in middleware.

### 2. Subscription tier (`restaurants.plan_type`)

Some permissions are additionally gated by the restaurant's plan:

| Feature | Minimum plan |
|---|---|
| Basic menu + ordering | `free` |
| Advanced analytics (customer health trends, revenue breakdowns) | `premium` |
| White-label branding (custom domain, logo, colors) | `basic` |
| Multi-location staff management | `enterprise` |

```
manager.wants('view_advanced_analytics') AND restaurant.plan_type IN ('premium', 'enterprise')
```

### 3. Time-based

| Rule | Field(s) used |
|---|---|
| A guest can edit their own review within 48h of posting | `guest_reviews.created_at` |
| An order is "active" (guest can still cancel/modify via waiter) for up to 1h after placement, or until status leaves `placed`/`confirmed` | `orders.placed_at`, `orders.status` |
| A menu is only orderable during its active window | `menus.active_from`, `menus.active_until` |

### 4. Session/shift context

Kitchen staff should only see orders for the shift they're clocked into, not the full historical queue. This is backed by the `shifts` table in `SNAPORDER_DATABASE_SCHEMA.md`:

```
staff.currently_clocked_in === EXISTS(shifts WHERE staff_id = staff.id AND clock_out IS NULL)
```

```sql
-- Kitchen queue scoping: only show staff who are actually clocked in right now.
SELECT * FROM restaurant_staff rs
JOIN shifts s ON s.staff_id = rs.id AND s.clock_out IS NULL
WHERE rs.restaurant_id = $1 AND rs.role = 'kitchen_staff';
```

A staff member can only have one active shift at a time (`unique_active_shift_per_staff`), and `shifts.role_during_shift` snapshots their role at clock-in so a later role change doesn't retroactively alter what an already-worked shift was authorized for.

### 5. State-based

Actions are often only valid when a resource is in a specific state:

| Action | Required state |
|---|---|
| Kitchen accepts an order | `orders.status = 'placed'` or `'confirmed'` |
| Guest cancels their own order | `orders.status IN ('placed', 'confirmed')` — not once `preparing` has started |
| Manager marks a meal available again | Reverses `meals.is_available = false` |
| Restaurant responds to a review | `guest_reviews.is_public = true` |

### 6. Geo-proximity (guest access) — implemented 2026-09-17

The product requirement stated plainly by the user: guests "can only have access to the site when in the place or a short distance from the place." A QR code alone isn't proof of physical presence — it can be photographed and shared — so a guest's actual location at scan time is checked against the restaurant's.

```
CAN_ISSUE_GUEST_SESSION = haversine_distance(guest.reported_location, restaurant.location) <= restaurant.max_guest_distance_meters
```

- `restaurants.latitude`/`longitude`/`max_guest_distance_meters` (table 1) — per-restaurant, not a global constant, consistent with the white-label customizability requirement (a restaurant with a large lot reasonably wants a bigger radius than one on a single storefront).
- **Fails closed:** a restaurant with no `latitude`/`longitude` configured blocks guest sessions entirely — there's nothing to check distance against, so "unchecked" is not a safe default here.
- `backend/src/geo.js` — Haversine distance, verified against known reference distances (e.g. London–Paris ≈ 344km) before being trusted for anything.
- `POST /v1/tables/:qrCodeId/scan` (`backend/src/routes/guestSession.js`) is where this is actually enforced — see `SNAPORDER_API_CONTRACTS.md`. A successful check issues a `guest_sessions` row (table 20) and a short-lived (`GUEST_SESSION_EXPIRY`, default 4h) guest JWT.
- Unlike staff tokens, a guest token's `restaurant_id`/`table_id` ARE embedded directly (not resolved fresh per request) — a deliberate difference from the staff design in Part 0/Part 4: a guest session's table doesn't change mid-session the way a staff member's role can, so there's no staleness risk to avoid. The session row is still the source of truth for whether it's still *valid* (`authenticateGuest` checks `expires_at` against the row, not just the JWT's own `exp` — verified live that revoking a session early, before its JWT naturally expires, is honored immediately).

---

## Part 3: Allergen Ingredient-Removal Policy (an ABAC application)

This is the concrete example that prompted this whole document, and it's built entirely from Parts 1–2 above — no separate mechanism.

**Default behavior is permissive.** A guest with an allergy can ask for a specific ingredient to be removed from a dish, and by default the system allows it. A restaurant can override that default per ingredient-per-meal when removal genuinely isn't safe or possible (e.g., an oil blended into a base sauce rather than added as a discrete topping).

### Three-state result

| State | Meaning | Guest sees |
|---|---|---|
| `can_remove` | Ingredient is a discrete, separable component. Removal is honored automatically. | Removal applied silently; confirmed in order summary. |
| `caution` | Removable, but there's a real residual risk (shared fryer oil, cross-contamination in prep area). | A warning shown before the guest confirms; guest must explicitly acknowledge it to proceed. |
| `cannot_remove` | Ingredient is mixed into the base and can't be safely separated. | Request is blocked, with the reason shown, and the system suggests alternative dishes that don't contain the allergen. |

### Who controls what

- **Manager/Owner** sets the policy per `meal_ingredients` row (`can_remove` / `caution` / `cannot_remove`, plus the reason/warning text shown to the guest).
- **Guest** can *request* removal of anything; the system — not the guest — decides which of the three states applies, based on the manager's policy.
- **Kitchen Staff** sees the resolved policy result on the order (e.g., "Remove peanuts [caution: shared fryer]") but has **no override control**. If kitchen genuinely cannot honor a `can_remove` item on a given day (e.g., unexpected prep issue), that's escalated to a manager and logged — it is never silently handled by kitchen changing the outcome the guest already saw.

### Schema changes needed (see also the DB schema doc, updated alongside this file)

```sql
-- meal_ingredients.can_be_removed (BOOLEAN) becomes a 3-state policy:
ALTER TABLE meal_ingredients
  DROP COLUMN can_be_removed,
  ADD COLUMN removal_policy ENUM('can_remove', 'caution', 'cannot_remove') DEFAULT 'can_remove',
  ADD COLUMN removal_policy_reason TEXT;  -- shown to guest for 'caution' and 'cannot_remove'

-- order_items needs to record that a guest actually saw and accepted a caution warning:
ALTER TABLE order_items
  ADD COLUMN allergen_caution_acknowledged BOOLEAN DEFAULT FALSE;
```

### Example flow

1. Guest viewing "Jollof Rice" requests peanuts removed (they're allergic).
2. System looks up `meal_ingredients` for (Jollof Rice, peanuts) → `removal_policy = 'cannot_remove'`, `removal_policy_reason = 'Peanut oil is blended into the base sauce and cannot be separated'`.
3. Guest sees the block + reason, and the menu suggests "Rice & Beans" (no peanut ingredient) as an alternative.
4. If instead the policy were `caution` (e.g., "prepared in a shared fryer with peanut oil"), the guest sees the warning, checks a box to acknowledge, and the order proceeds with `allergen_caution_acknowledged = true` recorded.
5. Either way, the resolved decision — not the raw request — is what reaches the kitchen display, tagged `priority: "high"` (already part of the KDS WebSocket contract in `SNAPORDER_API_CONTRACTS.md`).

---

## Part 4: Enforcement Pattern (API layer) — implemented

Every protected endpoint composes two middlewares: `authenticate` (verifies the JWT and loads the requester — `backend/src/middleware/auth.js`) and `authorize` (checks RBAC + ABAC for that specific route — `backend/src/middleware/authorize.js`). **Both are real as of 2026-09-17.**

`authorize`'s built-in ownership check works a little differently from the original illustrative version below, in a way worth calling out: rather than comparing `actor.restaurant_id` to the route's `:restaurantId` as a separate ABAC step, the restaurant-scoped lookup itself (`SELECT ... FROM restaurant_staff WHERE user_id = $1 AND restaurant_id = $2`) *is* the ownership check — it's structurally impossible to get a matching row back for a restaurant you're not staff at, so there's nothing separate to remember to compare. The permission matrix (Part 1) is transcribed as data in `backend/src/authorization/permissions.js`, and `restaurant_staff.is_active` is re-checked on every call (closing the gap noted in Part 0).

```javascript
// backend/src/authorization/permissions.js
export function roleGrants(role, permissionKey) { /* looks up the matrix */ }

// backend/src/middleware/authorize.js
export function authorize(permissionKey, options = {}) {
  const { restaurantIdParam = 'restaurantId', abac } = options;
  return async (req, res, next) => {
    const restaurantId = req.params[restaurantIdParam];
    const { rows: [staff] } = await pool.query(
      `SELECT id, restaurant_id, role, is_active, name FROM restaurant_staff WHERE user_id = $1 AND restaurant_id = $2`,
      [req.user.id, restaurantId]
    );
    if (!staff) return deny('You have no role at this restaurant');       // ownership
    if (!staff.is_active) return deny('...has been deactivated');        // deprovisioning
    if (!roleGrants(staff.role, permissionKey)) return deny(`Role '${staff.role}' cannot '${permissionKey}'`); // RBAC
    if (abac && !(await abac(staff, req))) return deny('Not allowed for this resource or in its current state'); // extra ABAC
    req.actor = staff;
    next();
  };
}

// Working example: backend/src/routes/staff.js
app.use('/v1/restaurants/:restaurantId/staff', staffRoutes); // GET / -> authenticate, authorize('view_staff')
```

Verified live against real data (register two restaurants, cross-restaurant access attempt, a role that lacks the permission, then that same role deactivated) — see the commit for the full sequence. Every one of the four denial paths (no role at this restaurant / deactivated / role lacks permission / extra ABAC condition failed) produces a distinct message and a distinct `audit_log` row (Part 5).

**Still not built:** `authorize` only covers the four `restaurant_staff` roles (waiter/kitchen_staff/manager/owner) — see the scope note in `permissions.js`. `guest` actions (place an order, leave a review) and `system_admin` actions need their own enforcement path once those identities have real backing (guest session handling, and the `platform_admins` table respectively) — this doc's permission matrix already covers what they should be allowed, just not how to check it yet.

---

## Part 5: Audit Trail — denials implemented

Every DENIED authorization decision, and every state-changing ALLOWED one, should be recorded in the existing `audit_log` table (`SNAPORDER_DATABASE_SCHEMA.md`). No new table needed — this uses what's already there. **Denials are implemented:** every `authorize()` rejection writes a row via `backend/src/audit.js`'s `logAudit()` (actor, restaurant, the permission checked, why it failed, the request path) — verified live, see Part 4. **Allowed-action logging for specific sensitive operations (a refund, a staff removal) is not automatic** — `logAudit()` is exported for any route handler that wants to call it explicitly; none do yet, since none of those routes exist.

**Real gap found and fixed 2026-09-17 (via a live Postgres error log, not a report):** `audit_log.restaurant_id` used to be a hard `REFERENCES restaurants(id) ON DELETE CASCADE` (`SNAPORDER_DATABASE_SCHEMA.md` table 17). A denial against a well-formed-but-nonexistent `restaurantId` — exactly the shape of a tenant-enumeration probe — failed that FK check on write, and `logAudit()` deliberately swallows its own errors so a logging bug can never break a real request. Net effect: this entire category of denial was invisible everywhere except ephemeral console output, never actually reaching this table. Migration 011 dropped the FK (soft reference now, not enforced or cascaded) — verified live: the same probe now correctly produces both the `403` response and a durable `audit_log` row, with a regression test (`backend/tests/integration/auditLog.test.js`) covering it going forward.

```sql
INSERT INTO audit_log (restaurant_id, action, actor_type, actor_id, resource_type, resource_id, changes, ip_address)
VALUES ($1, 'authz_denied', 'staff', $2, 'menu_meal', $3, '{"permission": "edit_menu", "reason": "wrong_restaurant"}', $4);
```

`audit_log.action` enum should be extended to include `authz_denied` alongside the existing `order_placed`, `order_cancelled`, `menu_updated`, `inventory_updated`, `review_posted`, `staff_login`.

---

## Part 7: PAM — Privileged Access Management

RBAC/ABAC (Parts 1–2) govern *everyone*. PAM adds extra controls specifically for the accounts that can do the most damage if compromised or misused: **Owner** and **System Admin** (and, situationally, **Manager** when performing destructive actions like refunds or deleting a meal).

### Why these roles need more than RBAC alone

A leaked Waiter token exposes one restaurant's order queue. A leaked System Admin token exposes every restaurant on the platform. The blast radius isn't linear with the permission matrix — it justifies controls beyond "is this role allowed to do this."

### PAM controls

| Control | Applies to | What it means here |
|---|---|---|
| **Least privilege by default** | All privileged roles | Owner and System Admin accounts get exactly the permissions in Part 1's matrix — no blanket "superuser" bypass of RBAC/ABAC. A System Admin viewing a restaurant's data still goes through the same ownership checks, logged as platform-level access rather than silently exempted. |
| **Mandatory MFA** | Owner, System Admin | Email+password alone is not enough for these two roles — a second factor (TOTP app) should be required at login. Manager is a strong candidate to require it too, given refund/policy powers; Waiter/Kitchen Staff don't need it given their limited blast radius. |
| **Just-in-time elevation** | System Admin | A System Admin's day-to-day access shouldn't include standing read/write into every restaurant's data. Cross-restaurant access should be requested for a specific reason (e.g. a support ticket), time-boxed, and auto-expire — not an always-on permission. |
| **Privileged session audit** | Owner, System Admin | Every privileged action (refund, staff removal, cross-restaurant analytics view, policy override attempt) is written to `audit_log` with actor, action, resource, and reason — building on the `authz_denied` action already added in Part 5, extended to explicitly log privileged *allowed* actions too, not just denials. |
| **Credential protection** | Platform secrets | `JWT_SECRET` and database credentials are the platform's own "privileged accounts" — they must live only in environment variables (already the case per `.env`/`.env.example`), be rotated periodically, and never appear in logs, error messages, or client-visible responses. |
| **Break-glass procedure** | System Admin | For genuine emergencies (e.g. a restaurant locked out and unreachable), a documented emergency-access path should exist — but it must still be logged and require post-hoc justification, not be a silent bypass. Not yet designed; flagged in Part 6. |

---

## Part 6: Not Yet Built (explicitly out of scope for this doc)

- ~~`platform_admins` table~~ **DONE 2026-09-17** (migration 004) — `requirePlatformAdmin()` (`backend/src/middleware/authorizePlatform.js`) is the System Admin counterpart to `authorize()`. Verified live in isolation (denied, then allowed after granting) — **no real route uses it yet**, since no platform-level resource (cross-restaurant analytics, roadmap status) exists to protect.
- ~~Guest-side enforcement~~ **PARTIALLY DONE 2026-09-17:** guest *identity and access-gating* is built — `POST /v1/tables/:qrCodeId/scan` (proximity-checked, Part 2 condition 6) issues a session, `authenticateGuest` verifies it. What's still missing is everything a guest would actually *do* with that session — `place_order`, `request_ingredient_removal`, `leave_review`, `vote_suggestion` (Part 1) have no routes yet. The identity mechanism guest actions will need is now built; the actions themselves aren't.
- ~~Adding staff to an *existing* restaurant~~ **DONE 2026-09-17:** `POST /v1/restaurants/:restaurantId/staff` (`manage_staff`, Owner/System Admin only), `backend/src/routes/staff.js`. Reuses an existing `users` row by email when one exists rather than always creating a login — verified live that the same person can end up staff at two different restaurants with one login, exactly the scenario the `users`/`restaurant_staff` split (Part 0) was built for.
- ~~Orders — `view_all_orders`, `modify_order`, `cancel_order`, `update_kitchen_item_status`~~ **DONE 2026-09-17:** `backend/src/routes/restaurantOrders.js`, mounted at `/v1/restaurants/:restaurantId/orders`. Order status and item status are two separately-enforced permissions with genuinely different role sets (`modify_order`: waiter/manager/owner/admin, not kitchen_staff; `update_kitchen_item_status`: kitchen_staff/manager/owner/admin, not waiter) — verified live that each role is correctly rejected on the endpoint it shouldn't have access to. Both endpoints validate transitions against a real state machine (e.g. `confirmed → served` directly is rejected, `409`), not any-status-to-any-status. `cancel_order` is currently folded into the same `modify_order` check for staff — noted in the code as correct only because the two permissions currently grant identical staff role sets; revisit if the matrix ever diverges them.
- ~~Menu writes, payment, analytics~~ **PARTIALLY DONE 2026-09-17:** `edit_menu` → `POST /v1/restaurants/:restaurantId/meals` (meal creation); `view_restaurant_analytics` → `GET /v1/restaurants/:restaurantId/analytics/daily`; `pay_own_order` → `POST /v1/orders/:id/payments/initialize` + Paystack webhook (`backend/src/paystack.js`). Still not built: inventory writes (`set_inventory_levels`, `mark_out_of_stock`), `issue_refund`, `view_payment_history`, `view_platform_analytics`, the `/analytics/revenue` period-breakdown endpoint.
- MFA implementation for Owner/System Admin (Part 7) — no TOTP flow exists yet.
- Just-in-time elevation and break-glass workflow for System Admin (Part 7) — currently only specified as a requirement, not designed in detail.

---

**Doc version:** 1.9 — fixed a real audit-logging gap (Part 5): `audit_log.restaurant_id`'s hard FK constraint silently dropped denial records for any nonexistent-restaurant probe; now a soft reference (migration 011)
**Previous:** 1.8 — added `manage_tables` permission (Part 1, QR code generation) and implemented `edit_menu`/`view_restaurant_analytics`/`pay_own_order` for real (meal creation, daily analytics, Paystack payments); addressed a role-naming conflict ("Chef"/"Cashier") directly rather than forking a second role system
**Previous:** 1.7 — added `assign_table` permission (Part 1) and its implementation (`backend/src/routes/tables.js`, `table_assignments`), the first permission added to the matrix after the fact rather than part of the original design
**Status:** Design specification, ready for implementation
**Related:** `SNAPORDER_DATABASE_SCHEMA.md` (schema this model extends), `SNAPORDER_API_CONTRACTS.md` (endpoints this protects), `backend/src/auth.js` (JWT layer this builds on)
