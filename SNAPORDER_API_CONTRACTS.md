# SnapOrder REST API Contracts

## API Standards

- **Base URL:** `https://api.snaporder.ng/v1` (production)
- **Format:** JSON
- **Authentication:** Bearer JWT (OAuth 2.0)
- **Rate Limiting:** per-IP (see "Rate Limiting" section below for actual implemented limits — the original "1000/min per API key" here assumed an API-key model that doesn't exist yet; there's no API-key auth, only per-user JWTs)
- **Versioning:** URL-based (`/v1`, `/v2` in future)

---

## Restaurants

Implemented (2026-09-17) — `backend/src/routes/restaurants.js`. **Public — no auth.** New, not in earlier drafts of this doc, which always assumed a client already knows which restaurant it's dealing with (via QR scan). A directory/browse view was worth adding: same public-vs-internal split as the design intent elsewhere (return `name`/`description`/`address`/`logo_url`/`opening_hours` etc., never `email`/`registration_number`/`tax_id`/subscription dates/`max_guest_distance_meters`).

### GET `/v1/restaurants`
List active restaurants.

**Query Params:** `page` (default 1), `per_page` (default 20, max 50 — bounded so this can't become an unbounded "return everything" query as the platform grows)

**Response (200):**
```json
{
  "data": [
    {
      "id": "uuid", "name": "Tantalizers Nigeria", "description": null,
      "address": null, "city": null, "state": null, "country": "Nigeria",
      "logo_url": null, "primary_color": null, "secondary_color": null,
      "latitude": "6.524400", "longitude": "3.379200",
      "opening_hours": { "monday": { "open": "09:00", "close": "22:00" }, "sunday": null },
      "created_at": "2026-09-17T13:25:06.258Z"
    }
  ],
  "pagination": { "total": 1, "page": 1, "per_page": 20 }
}
```

### GET `/v1/restaurants/{id}`
Single restaurant. Same public field set, plus `is_active` — an inactive restaurant is returned (not `404`), so a client can distinguish "temporarily unavailable" from "never existed" and show an appropriate message either way.

**Response (404)** if the id doesn't exist or isn't validly formed.

---

## Authentication Endpoints

Implemented in `backend/src/routes/auth.js`, mounted at `/v1/auth` (as of 2026-09-17 — see the versioning note below). Both routes sit behind `authLimiter` in addition to the global rate limiter (`backend/src/middleware/rateLimit.js`): 10 failed attempts / 15 min per IP.

### POST `/v1/auth/register`
Register a new restaurant, its first (Owner) user account, and the link between them, in one request.

**Request:**
```json
{
  "restaurant_name": "Tantalizers Nigeria",
  "owner_name": "Ada Okafor",
  "email": "admin@tantalizers.ng",
  "phone": "+234 811 234 5678",
  "password": "SecurePassword123!",
  "address": "12 Lagos Street, Lagos Island",
  "registration_number": "RC 123456"
}
```
`restaurant_name`, `owner_name`, `email`, `password` (min 8 characters) are required. `owner_name` was added during implementation — the schema's `restaurant_staff.name` is required and there's no sensible default for a person's name, so it wasn't optional. `phone`/`address`/`registration_number` are optional.

**Response (201):**
```json
{
  "id": "uuid-here",
  "name": "Tantalizers Nigeria",
  "email": "admin@tantalizers.ng",
  "status": "active",
  "created_at": "2025-09-16T10:30:00Z"
}
```

**Response (409)** if the email is already registered (as a `users.email` or a `restaurants.email`):
```json
{ "error": { "code": "CONFLICT", "message": "An account with this email already exists" } }
```

---

### POST `/v1/auth/login`
Restaurant staff login.

**Request:**
```json
{
  "email": "admin@tantalizers.ng",
  "password": "SecurePassword123!"
}
```

**Response (200):**
```json
{
  "access_token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
  "expires_in": 21600,
  "user": {
    "id": "uuid-here",
    "name": "Manager Name",
    "email": "admin@tantalizers.ng",
    "role": "manager",
    "restaurant_id": "uuid-here"
  }
}
```
No `refresh_token` — refresh-token issuance/rotation isn't implemented yet (tracked separately as a known gap); omitted rather than returning a fake one. `expires_in` (seconds) is read back from the actual issued token's `exp`/`iat`, so it always matches `JWT_EXPIRY` exactly rather than risking drift from a hardcoded value.

**Response (401)** — deliberately the *same* message whether the email doesn't exist or the password is wrong, so a client can't use this endpoint to enumerate which emails have accounts:
```json
{ "error": { "code": "UNAUTHORIZED", "message": "Invalid email or password" } }
```

A user with no active `restaurant_staff` row gets **403 FORBIDDEN** ("This account has no active restaurant role") instead — they authenticated correctly, but there's nothing for them to do here.

If a user has staff rows at more than one restaurant, login currently just picks the oldest one — there's no "choose which restaurant" step yet. Flagged as a real simplification, not an oversight (see `SNAPORDER_AUTHORIZATION.md` Part 0).

---

### GET `/v1/me`
Not part of the original spec — added alongside the `authenticate` middleware (`backend/src/middleware/auth.js`) as the natural way to verify it end-to-end, and useful in its own right (e.g. a frontend checking "is my stored token still valid" on load).

**Headers:** `Authorization: Bearer <access_token>`

**Response (200):**
```json
{ "user": { "id": "uuid-here", "email": "admin@tantalizers.ng", "created_at": "2025-09-16T10:30:00Z" } }
```
Note this is the base `users` row only (id/email/created_at) — not role or restaurant_id, since `authenticate` is authentication only ("who are you"), not authorization ("what can you do where"). A route that needs role/restaurant context resolves it separately from `restaurant_staff`, scoped to whichever `:restaurantId` the request concerns.

**Response (401)** if the `Authorization` header is missing/malformed, the token is invalid or expired, or the account it names no longer exists.

---

## Guest Session

Implemented 2026-09-17 (`backend/src/routes/guestSession.js`). This is the actual entry point of the guest experience — scanning the table's QR code — and where the product's proximity requirement is enforced: "guests can only have access when in the place or a short distance from it." Not behind `authenticate`/`authorize` — a guest has no identity yet at this point; that's what these routes create.

### POST `/v1/tables/{qrCodeId}/scan`
Scan a table's QR code. Requires the guest's current coordinates (read from the browser's Geolocation API on the frontend) — the request fails if they're too far from the restaurant.

**Request:**
```json
{ "latitude": 6.5244, "longitude": 3.3792 }
```

**Response (201):**
```json
{
  "session_token": "eyJhbGciOiJIUzI1NiIs...",
  "expires_at": "2026-09-17T18:09:19.000Z",
  "restaurant": { "id": "uuid", "name": "Geo Test Diner" },
  "distance_meters": 50
}
```

**Response (403)** — one of three distinct reasons:
```json
{ "error": { "code": "FORBIDDEN", "message": "You need to be at {restaurant} to order here — you appear to be about {N}m away (max {M}m)." } }
```
or `"This restaurant has not configured its location yet — guest ordering is unavailable until it does"` (fails closed, not open, if the restaurant hasn't set its location), or `"This table is not currently active"`.

**Response (404)** if the QR code doesn't match any table. **Response (400)** if `latitude`/`longitude` are missing or out of range.

### GET `/v1/guest/session`
"Who is this guest session" — the guest counterpart to `GET /v1/me`, and the way to verify a stored session token is still good (e.g. on page reload).

**Headers:** `Authorization: Bearer <session_token>`

**Response (200):**
```json
{
  "session": { "id": "uuid", "table_id": "uuid", "restaurant_id": "uuid", "guest_profile_id": null, "expires_at": "2026-09-17T18:09:19.000Z" },
  "restaurant_name": "Geo Test Diner",
  "table_number": 1,
  "server": { "name": "Wendy", "role": "waiter" }
}
```
`server` (added 2026-09-17, explicit user request: "the guest should know the staff that is assigned to serving them") is whoever's currently assigned to this table via `POST /v1/restaurants/{restaurantId}/tables/{tableId}/assign` (see Table Assignment below), or `null` if nobody is. `name` here is `display_name` when the staff member has set one, else their full `name` — see Staff Management for `display_name`.

**Response (401)** if the token is missing, expired, not a guest-type token (e.g. a staff token was used here by mistake), or the session no longer exists — including if it was revoked early (`guest_sessions.expires_at` set into the past), even though the JWT itself hasn't naturally expired yet.

---

## Menu Management

Implemented (2026-09-17): `GET /v1/restaurants/{restaurantId}/menus`, `GET /v1/meals/{id}`, `GET /v1/meals/{id}/ingredients` — `backend/src/routes/menus.js`. **Public — no auth.** `view_menu` (`SNAPORDER_AUTHORIZATION.md` Part 1) has no ABAC condition attached to it, unlike ordering — browsing is intentionally open even though placing an order requires a proximity-verified guest session (see Guest Session, Orders below).

### GET `/v1/restaurants/{restaurantId}/menus`
Get all menus for a restaurant.

**Query Params:**
- `active_only` — defaults to `true` (only `is_active=true` menus); pass `active_only=false` to see everything.

**Response (200):**
```json
{
  "data": [
    {
      "id": "uuid",
      "name": "Lunch Menu",
      "description": "Available 12pm-3pm",
      "active_from": "12:00",
      "active_until": "15:00",
      "is_active": true,
      "categories_count": 5,
      "meals_count": 32
    }
  ]
}
```
`categories_count`/`meals_count` come from one `LEFT JOIN` + `GROUP BY` query, not a loop of per-menu queries (N+1) — see the code comments in `menus.js`. `meals_count` only counts `is_available = true` meals.

---

### GET `/v1/restaurants/{restaurantId}/menus/{menuId}/meals`
Implemented (2026-09-18) — `backend/src/controllers/menuController.js`. **Supersedes** the "not yet built" note this used to carry: a menu's categories, each with its available (`is_available = true`) meals nested — built specifically to unblock the frontend menu-browsing page (`frontend/src/pages/MenuPage.jsx`), which needs one call to render a whole menu rather than fetching meals one at a time. A category with zero available meals still appears, with `meals: []`, rather than silently disappearing.

**Response (200):**
```json
{
  "id": "uuid", "name": "Main Menu", "description": null,
  "categories": [
    {
      "id": "uuid", "name": "Mains",
      "meals": [
        { "id": "uuid", "name": "Jollof Rice", "description": null, "image_url": null, "base_price": "3500.00", "currency": "NGN", "calories": null, "protein_grams": null, "is_vegan": false, "is_vegetarian": false, "is_gluten_free": false, "is_low_calorie": false, "is_high_protein": false, "estimated_prep_time_minutes": null }
      ]
    },
    { "id": "uuid", "name": "Drinks", "meals": [] }
  ]
}
```
**Response (404)** if the menu doesn't exist or doesn't belong to `restaurantId`.

---

### GET `/v1/meals/{id}`
Meal details, with ingredients and addons joined in.

**Response (200):**
```json
{
  "id": "uuid",
  "name": "Grilled Chicken Rice",
  "description": "Fresh chicken grilled with jasmine rice",
  "base_price": "2500.00",
  "currency": "NGN",
  "calories": 450,
  "protein_grams": 28,
  "is_available": true,
  "category_name": "Mains",
  "ingredients": [
    { "id": "uuid", "name": "Chicken breast", "allergen_type": "none", "removal_policy": "can_remove", "removal_policy_reason": null, "is_required": false },
    { "id": "uuid", "name": "Rice", "allergen_type": "none", "removal_policy": "cannot_remove", "removal_policy_reason": "Cooked together, can't be separated" }
  ],
  "addons": [
    { "id": "uuid", "name": "Extra Chicken", "additional_price": "800.00", "max_quantity": 1 }
  ]
}
```
Note: `removal_policy` (3-state: `can_remove`/`caution`/`cannot_remove`) replaces an earlier draft's boolean `can_be_removed` shown in this doc previously — that boolean was never accurate once `SNAPORDER_DATABASE_SCHEMA.md`'s allergen policy engine (table 8) landed; this section just hadn't been updated to match until now. No `reviews` aggregate yet (`guest_reviews` querying isn't wired to this endpoint).

**Response (404)** if the meal doesn't exist.

---

### GET `/v1/meals/{id}/ingredients`
Just the ingredient list from the endpoint above, as its own lighter-weight fetch (e.g. an allergen-check UI that doesn't need the rest of the meal payload).

**Response (200):** `{ "data": [ ...same ingredient objects as above... ] }`

---

### POST `/v1/restaurants/{restaurantId}/meals`
Create a new meal. Implemented (2026-09-17) — `backend/src/controllers/menuController.js`, behind `authenticate` + `authorize('edit_menu')` (manager/owner/system_admin). **Supersedes** the earlier `POST /restaurants/{restaurantId}/menus/{menuId}/meals` design-target path above — the real route takes `category_id` in the body instead of `menuId` in the URL, since a meal belongs to a category, not directly to a menu.

**Request:**
```json
{
  "category_id": "uuid",
  "name": "Suya Skewers",
  "description": "Grilled beef skewers, pepper-spiced",
  "base_price": 2500,
  "calories": 320,
  "is_high_protein": true
}
```
`category_id`, `name`, `base_price` (positive number) are required; every other field is optional. `category_id` must belong to a menu at `restaurantId` — a category from a different restaurant is rejected with `400`, not silently attached.

**Response (201):** the inserted meal row (same shape as `GET /v1/meals/{id}` minus the joined `category_name`/`ingredients`/`addons`).

---

## Orders

Implemented (2026-09-17): `POST /v1/orders`, `GET /v1/orders/{id}` — `backend/src/routes/orders.js`. Both behind `authenticateGuest` — this **supersedes an earlier draft** of this section that used `POST /tables/{tableId}/orders` with an `X-Guest-Phone` header, which predates the guest-session work (`SNAPORDER_AUTHORIZATION.md` Part 2 condition 6) and no longer reflects how guest identity actually works. `guest_profiles` are created here, on first order, exactly as the product design always specified — not at scan time.

### POST `/v1/orders`
Place an order.

**Headers:** `Authorization: Bearer <guest session_token>` (from `POST /v1/tables/{qrCodeId}/scan`)

**Request:**
```json
{
  "phone_number": "+234 811 234 5678",
  "guest_name": "Adeola K.",
  "items": [
    {
      "meal_id": "uuid",
      "quantity": 1,
      "removed_ingredients": ["ingredient_uuid_1"],
      "allergen_caution_acknowledged": false,
      "added_addons": ["addon_uuid_1"],
      "special_request": "No oil, extra spicy"
    }
  ],
  "special_requests": "Table is allergic to peanuts",
  "tip_amount": 300
}
```
`removed_ingredients` are checked against each ingredient's `removal_policy` (`SNAPORDER_AUTHORIZATION.md` Part 3) for **every** item before anything is written:
- `cannot_remove` → whole order rejected, **403**, no partial order created.
- `caution` → requires that item's `allergen_caution_acknowledged: true`, else **400** asking for it.
- `can_remove` → honored silently.

`table_id`/`restaurant_id` are NOT in the request body — they come from the authenticated guest session, so a guest can only ever order for the table they actually scanned. `tip_amount` is optional and entirely guest-discretion — omit it for no tip; if given, must be a non-negative number.

**Response (201):**
```json
{
  "id": "order_uuid",
  "order_number": "ORD-2026-00147",
  "status": "placed",
  "subtotal": "6600.00",
  "tax": "495.00",
  "service_charge": "660.00",
  "total_amount": "7755.00",
  "tip_amount": "300.00",
  "grand_total": 8055,
  "currency": "NGN",
  "placed_at": "2026-09-17T10:30:00Z",
  "items": [
    { "id": "item_uuid", "meal_id": "uuid", "meal_name": "Grilled Chicken Rice", "meal_price": "3300.00", "quantity": 2, "status": "pending" }
  ]
}
```
`meal_price` on each item is `base_price + sum(addon prices)` — a **snapshot** at order time, so a later menu price change never retroactively changes an already-placed order. `tax`/`service_charge` are computed from the restaurant's own `tax_rate`/`service_charge_rate` (both default to 0, so a restaurant that hasn't configured either simply gets 0 — not a made-up default). `total_amount = subtotal + tax + service_charge`; **`tip_amount` is deliberately excluded from `total_amount`** (a receipt reads "Total: X, tip at your discretion," not one number silently including it) — `grand_total` (`total_amount + tip_amount`) is the actual amount owed, returned in the response but not its own stored column. No `payment_url` — no payment integration exists yet (see known gaps).

**Response (400)** for a meal that doesn't exist/isn't at this restaurant, an unavailable meal, an addon that isn't valid for the meal, a missing `caution` acknowledgment, or a negative `tip_amount`. **Response (403)** for a blocked (`cannot_remove`) ingredient removal.

---

### GET `/v1/orders/{id}`
Get order status. Ownership is table-based: the order's `table_id` must match the authenticated guest session's `table_id` — see `orders.js` for why this is more correct than matching on `guest_profile_id` (a re-scan starts a new session whose `guest_profile_id` is null again until it orders).

**Headers:** `Authorization: Bearer <guest session_token>`

**Response (200):**
```json
{
  "id": "order_uuid",
  "order_number": "ORD-2026-00147",
  "status": "placed",
  "placed_at": "2026-09-17T10:30:00Z",
  "confirmed_at": null,
  "ready_at": null,
  "total_amount": "6600.00",
  "tip_amount": "300.00",
  "grand_total": 6900,
  "payment_status": "pending",
  "payment_reference": null,
  "server": { "name": "Wendy", "role": "waiter" },
  "items": [
    { "id": "item_uuid", "meal_name": "Grilled Chicken Rice", "quantity": 2, "status": "pending", "special_request": "Extra spicy" }
  ]
}
```
`payment_status`/`payment_reference` added 2026-09-18 — previously missing here even though the Payments section's endpoints have written them since migration 010; the frontend order-status page (`frontend/src/pages/OrderStatusPage.jsx`) needs this to decide whether to show a "Pay with Paystack" button.

**Response (403)** `"This order does not belong to your table"` if the order exists but belongs to a different table. **Response (404)** if it doesn't exist at all — verified live that these two cases are distinguishable to a legitimate caller.

---

## Order Management (Staff/Kitchen)

Implemented (2026-09-17) — `backend/src/routes/restaurantOrders.js`. Mounted at `/v1/restaurants/{restaurantId}/orders`, behind `authenticate` + `authorize()`. This is the piece flagged as missing right after guest ordering shipped — a guest could place and check their own order, but nothing on the restaurant side could act on one.

### GET `/v1/restaurants/{restaurantId}/orders`
List a restaurant's orders. Requires `view_all_orders` (waiter, kitchen_staff, manager, owner, system_admin).

**Query Params:** `status` — comma-separated (e.g. `?status=placed,confirmed,preparing` for a kitchen-queue-style view). Omit for all statuses.

**Response (200):** `{ "data": [ {...order fields, no items array...} ] }`

### PATCH `/v1/restaurants/{restaurantId}/orders/{orderId}/status`
Advance (or cancel) an order. Requires `modify_order` (waiter, manager, owner, system_admin — **not** kitchen_staff). Verified live that a kitchen_staff token is rejected here even though it's accepted on the item-status endpoint below — the two permissions are genuinely different in the RBAC matrix, not interchangeable.

**Request:** `{ "status": "confirmed" }` — one of `placed`, `confirmed`, `preparing`, `ready`, `served`, `cancelled`.

Transitions are validated against a real state machine, not accepted as any-to-any:
```
placed → confirmed | cancelled
confirmed → preparing | cancelled
preparing → ready | cancelled
ready → served
served, cancelled → (final states, no further transitions)
```
The relevant timestamp column (`confirmed_at`/`ready_at`/`served_at`/`cancelled_at`) is set automatically.

**Response (200):** `{ "id": "order_uuid", "status": "confirmed", "confirmed_at": "..." }`
**Response (409)** for an invalid transition (e.g. `confirmed` → `served` directly), naming the actually-valid next state(s). **Response (400)** for an unrecognized status value. **Response (404)** if the order isn't at this restaurant.

### PATCH `/v1/restaurants/{restaurantId}/orders/{orderId}/items/{itemId}/status`
Update one item's status (the kitchen's actual unit of work). Requires `update_kitchen_item_status` (kitchen_staff, manager, owner, system_admin — **not** waiter — the reverse restriction from the endpoint above).

**Request:** `{ "status": "preparing" }` — one of `pending`, `preparing`, `ready`, `served`, `cancelled`. Same state-machine validation as order status (`pending → preparing|cancelled → ready → served`).

**Response (200):** `{ "id": "item_uuid", "status": "preparing", "prepared_by_staff_id": "uuid" }` — records which staff member actually handled it (`req.actor`, from `authorize()`).

---

## Inventory Management

### GET `/restaurants/{restaurantId}/inventory`
Get current inventory levels.

**Response (200):**
```json
{
  "data": [
    {
      "id": "ingredient_uuid",
      "name": "Chicken breast",
      "current_stock": 15,
      "unit_of_measure": "kg",
      "reorder_level": 5,
      "status": "sufficient",  // "sufficient", "low", "out_of_stock"
      "last_updated": "2025-09-16T09:00:00Z"
    }
  ]
}
```

---

### PATCH `/restaurants/{restaurantId}/inventory/{ingredientId}`
Update ingredient stock.

**Request:**
```json
{
  "current_stock": 12,
  "reason": "used_in_orders"  // or "restocked", "waste", "adjustment"
}
```

**Response (200):** Updated ingredient object

---

### POST `/restaurants/{restaurantId}/meals/{mealId}/toggle-availability`
Toggle meal availability (quick restaurant action).

**Request:**
```json
{
  "is_available": false,
  "reason": "out_of_stock"  // or "maintenance", "not_ready"
}
```

**Response (200):**
```json
{
  "id": "meal_uuid",
  "is_available": false,
  "status_message": "Out of stock — back in 10 minutes"
}
```

---

## Staff Management

Implemented (as of 2026-09-17): `GET /v1/restaurants/{restaurantId}/staff` — `backend/src/routes/staff.js`. First real route behind `authorize()` (`SNAPORDER_AUTHORIZATION.md` Part 4) — the rest of this section's permission matrix (`edit_menu`, `issue_refund`, etc.) is designed but not wired to routes yet.

### GET `/v1/restaurants/{restaurantId}/staff`
List a restaurant's staff. Requires the `view_staff` permission (Manager/Owner/System Admin — see the RBAC matrix) **at this specific restaurant** — a token that's valid for a different restaurant gets `403`, not `404`, since the caller is authenticated, just not authorized for this resource.

**Headers:** `Authorization: Bearer <access_token>`

**Response (200):**
```json
{
  "data": [
    { "id": "uuid", "name": "Ada Okafor", "display_name": null, "role": "owner", "is_active": true, "created_at": "2026-09-17T12:58:14.604Z" }
  ]
}
```
`display_name` (added 2026-09-17) is the customizable, guest-facing name a staff member can go by — `null` until set, in which case `name` is shown to guests instead (see Guest Session's `server` field).

**Response (403)** — one of several distinct reasons, each also written to `audit_log`:
```json
{ "error": { "code": "FORBIDDEN", "message": "You have no role at this restaurant" } }
```
or `"Role 'waiter' cannot 'view_staff'"`, or `"Your access to this restaurant has been deactivated"`.

**Response (400)** if `restaurantId` isn't a valid UUID; **401** if the token is missing/invalid (from `authenticate`, before `authorize` even runs).

### POST `/v1/restaurants/{restaurantId}/staff`
Add staff to a restaurant that **already exists** — the other half of a gap flagged earlier: `POST /v1/auth/register` only covers onboarding a brand-new restaurant + its first Owner. Requires `manage_staff` (Owner/System Admin only — a Manager can view staff but not add them).

**Request (new person, no existing account):**
```json
{ "email": "waiter@example.ng", "name": "Wendy Waiter", "display_name": "Wendy", "role": "waiter", "password": "SecurePass123", "phone": "+234..." }
```
**Request (person already has a `users` account — e.g. also staff at another restaurant):**
```json
{ "email": "existing@example.ng", "name": "Their name here", "role": "manager" }
```
`role` must be one of `waiter`, `kitchen_staff`, `manager`, `owner`. `display_name` is optional. Omit `password` entirely when the email already has an account — reuses that login rather than creating a second one (the whole point of the `users`/`restaurant_staff` split, `SNAPORDER_DATABASE_SCHEMA.md` table 19: one person, one login, potentially many restaurants) — verified live that the same login ends up staff at two different restaurants with different roles at each.

**Response (201):** `{ "id": "uuid", "name": "Wendy Waiter", "display_name": "Wendy", "role": "waiter", "phone": null, "is_active": true, "created_at": "..." }`

**Response (400)** — `password` provided for an email that already has an account (rejected explicitly rather than silently ignored, so the caller can't mistakenly believe they changed someone else's password), missing `password` for a genuinely new account, or an invalid `role`.
**Response (409)** `"This person is already staff at this restaurant"` if that `user_id`+`restaurant_id` pairing already exists.

### PATCH `/v1/restaurants/{restaurantId}/staff/{staffId}`
Update a staff member's `display_name` — "customizable" implies editable, not just set once. Requires `manage_staff` (same as adding staff — there's no self-service "edit my own profile" route yet).

**Request:** `{ "display_name": "Wendy O." }` (or `{ "display_name": null }` to clear it back to showing `name`)

**Response (200):** `{ "id": "uuid", "name": "Wendy Waiter", "display_name": "Wendy O.", "role": "waiter", "is_active": true }`
**Response (404)** if the staff member isn't at this restaurant.

---

## Table Assignment

Implemented (2026-09-17) — `backend/src/routes/tables.js`, mounted at `/v1/restaurants/{restaurantId}/tables`. Explicit user request: "the guest should know the staff that is assigned to serving them." Both endpoints require `assign_table` (Manager/Owner/System Admin).

### POST `/v1/restaurants/{restaurantId}/tables/{tableId}/assign`
Assign a staff member to serve a table. Reassigning an already-assigned table ends the previous assignment and starts the new one atomically — a manager moving tables between servers mid-shift is one call, not an unassign-then-assign pair.

**Request:** `{ "staff_id": "uuid" }` — must be active staff at this same restaurant.

**Response (201):**
```json
{ "id": "assignment_uuid", "table_id": "uuid", "assigned_at": "2026-09-17T17:36:39.566Z", "staff": { "id": "uuid", "name": "Wendy", "role": "waiter" } }
```
**Response (400)** if `staff_id` isn't active staff at this restaurant. **Response (404)** if the table isn't at this restaurant.

### POST `/v1/restaurants/{restaurantId}/tables/{tableId}/unassign`
End the current assignment, if any — not an error if there wasn't one.

**Response (200):** `{ "table_id": "uuid", "was_assigned": true }`

---

## Payments

Implemented (2026-09-17) — `backend/src/paystack.js`, `backend/src/controllers/paymentController.js`, `backend/src/routes/{orders,payments}.js`. Paystack's REST API is called directly via `fetch`, not the `paystack`/`paystack-js` npm packages — both were removed from this project earlier (critical vulnerabilities, `npm audit`); a handful of plain HTTP calls isn't worth a dependency. `payment_transactions` (migration 010) is the full history of every attempt; `orders.payment_status`/`payment_reference` (migration 001) remain the single current-state fields, updated by the webhook below.

### POST `/v1/orders/{orderId}/payments/initialize`
Start a Paystack checkout for an order the guest already placed. Behind `authenticateGuest`, same table-based ownership check as `GET /v1/orders/{id}` — a guest can only pay for an order at their own table.

Paystack requires an `email` field; guests only ever provide a phone number (`guest_profiles`), so a synthesized address (`<phone>@guest.snaporder.app`) is sent — never actually mailed to, just satisfies the required field. Amount charged is `total_amount + tip_amount` (the `grand_total` concept from the Orders section above), converted to kobo.

**Request:** `{ "callback_url": "https://..." }` — optional; Paystack falls back to the account's dashboard-configured default when omitted (no frontend is deployed yet to redirect back to).

**Response (201):**
```json
{ "reference": "snap_...", "authorization_url": "https://checkout.paystack.com/...", "amount": "3937.50", "currency": "NGN", "status": "pending" }
```
**Response (403)** if the order isn't at the caller's table. **Response (409)** if `payment_status` is already `completed`.

---

### POST `/v1/payments/webhook`
Paystack calls this directly — no guest/staff session at all. The HMAC-SHA512 signature (`x-paystack-signature` header, verified against `PAYSTACK_WEBHOOK_SECRET`) **is** the authentication; there is no other check. Mounted in `index.js` with `express.raw()` **before** the app-wide `express.json()`, since the signature must be verified against the exact raw request bytes — re-parsing to JSON first would produce a different hash and reject every real webhook.

On a `charge.success`/`charge.failed` event matching a known `reference`, updates that `payment_transactions` row and, on success, sets `orders.payment_status = 'completed'` — one DB transaction, so a crash mid-update can't leave the two out of sync. Always acknowledges `200` once the signature is valid (Paystack retries on non-2xx; an event this endpoint doesn't act on is still acknowledged, not retried forever). An **invalid signature is rejected with `401`** and logged — the one case that isn't acknowledged.

---

## Bills & Payment Timing (IMPLEMENTED 2026-09-21 — migrations 013-015, `backend/src/{models,controllers,routes}/{bill,staffCall}*.js`)

Supersedes the payment endpoints above once built — see `SNAPORDER_DATABASE_SCHEMA.md`'s "Payment & Billing Model" section for the full schema and rationale (`table_sittings`, `bills`, `bill_splits`/`bill_split_shares`, `staff_calls`, `guest_visits`). Summary of the flow: a guest picks one of three timings (**Pay Now** / **Pay After** / **Pay Traditionally**); Pay Now/Pay After additionally can request a **split**, which defaults to **whole** (one consolidated bill) until explicitly requested; Pay Traditionally has no split choice and instead fires a waiter call.

**Revised 2026-09-21 from an earlier draft:** a bill is always exactly **one row per sitting** — a split does not create multiple bill rows (an earlier draft had this wrong). A split instead creates one `bill_splits` row plus N `bill_split_shares` rows *against that same bill*. This changes the endpoint shapes below from the original draft.

### POST `/v1/guest/session/bill`
Behind `authenticateGuest`. Gets-or-creates **the one bill** for the caller's table's current open sitting (idempotent — a second call for the same sitting returns the existing bill, it doesn't create another).

**Request:** `{ "timing": "pay_now" | "pay_after" | "pay_traditional" }`.

**Behavior:**
- Creates one `bills` row (`status: 'open'`) covering every order currently in the sitting.
- `timing: 'pay_traditional'` — also creates a `staff_calls` row (`reason: 'payment'`) and emits `waiter_called` to the `staff:{restaurantId}` socket room, and sets `bills.status = 'awaiting_payment'` immediately (no separate payment step to trigger — staff handle it in person).

**Response (201):** `{ id, timing, status, subtotal, tax, service_charge, tip_amount, total_amount }`.

### GET `/v1/guest/session/bill/:billId`
View the bill's current total/state — used for `pay_after` to check the running total before deciding to pay, and to poll status after initializing payment. Ownership check: the bill's `sitting_id` must match the caller's own guest session's sitting.

### POST `/v1/bills/:billId/request-split`
Behind `authenticateGuest`, same ownership check as above. **The only path that creates a split — nothing does it automatically.**

**Request:** `{ "split_type": "even" | "custom", "num_parties": number, "shares"?: [{ "guest_label": string, "amount_owed": number }] }` — `shares` required (and validated to sum to exactly `bills.total_amount`) when `split_type` is `custom`; ignored (auto-computed, even division with the remainder on the first share) when `even`.

Creates `bill_splits` + `bill_split_shares`, sets `bills.status = 'split_requested'`. Rejected (`409`) if the bill is already `split_requested` or later — a split can be requested once per bill.

**Once this succeeds, `POST /v1/bills/:billId/payments/initialize` (below) starts rejecting with `409`** — all payment for this bill must go through the per-share endpoint from this point on. This is the enforced version of "split only on explicit request, not by default."

### GET `/v1/bills/:billId/splits`
Returns the share breakdown (`guest_label`, `amount_owed`, `payment_status` per share) for display on each guest's own device.

### POST `/v1/bills/:billId/payments/initialize`
The default, whole-bill payment path — replaces `POST /v1/orders/{orderId}/payments/initialize` above with an identical Paystack flow (synthesized guest email, kobo conversion, `callback_url`), just keyed to a bill instead of a single order. **Rejected `409` if `bills.status` is `split_requested` or later** (see above) — once split, payment must go per-share. Rejected `400` if `bills.timing` is `pay_traditional` — that path never touches Paystack at all.

### POST `/v1/bills/splits/:shareId/payments/initialize`
Same Paystack flow, scoped to one `bill_split_shares.amount_owed` instead of the whole bill. When every share for a split reaches `paid`, the parent `bills.status` also flips to `paid`.

### POST `/v1/payments/webhook`
Unchanged mechanism (signature verification, `express.raw()` mounting). On success: if the reference matches a whole-bill payment, sets that `payment_transactions` row (now also carrying `bill_id`) and `bills.status = 'paid'`/`settled_at = NOW()`; if it matches a share, sets that share's `payment_status = 'paid'`/`paid_at`, and additionally checks whether all sibling shares are now `paid` to cascade the parent bill to `paid` too.

### PATCH `/v1/restaurants/{restaurantId}/staff-calls/{callId}`
Staff-side, `process_payment` permission (Waiter/Manager/Owner/System Admin). Body: `{ "status": "acknowledged" | "resolved" }`. Moving to `resolved` for a call tied to a `pay_traditional` bill also sets that bill's `status` to `settled_traditionally` — the staff-confirmed "I actually collected the payment" step, not something a guest action can complete on its own.

### GET `/v1/restaurants/{restaurantId}/staff-calls?status=pending`
Staff-side, `process_payment` permission. Lists open calls for the front-of-house view (a "tables asking for the bill" list) — the REST fallback/backfill for anyone who reconnects after missing the `waiter_called` socket event.

**Not designed yet, flagged rather than guessed:** itemized/by-item splitting (a third `split_type`, deferred — needs order-line-item-level UI); an explicit "close sitting" endpoint for staff (needed for a table that never completes checkout in-app); when/how `guest_visits` (schema doc, table 27) actually gets written — presumably on sitting close, not decided here.

**Real bug found and fixed while building this, 2026-09-21:** `bills.status` was declared `VARCHAR(20)` in migration 013, but its own CHECK constraint already listed `'settled_traditionally'` (22 characters) as valid — never caught until an integration test actually tried to write it via the staff-call resolve path. Fixed by migration 015 (widened to `VARCHAR(30)`). No frontend exists yet for any of this — guest pay-now/after/traditional + split UI, and the staff-side "tables asking for the bill" view, are the next real UI work.

---

## QR Codes

Implemented (2026-09-17) — `backend/src/models/qrModel.js`, `backend/src/controllers/qrController.js`, `backend/src/routes/qr.js`. Requested as `GET /api/qr/{restaurantId}/{tableNumber}` linking to `https://snaporder.app/?r={restaurantId}&t={tableNumber}` — built as `GET /v1/qr/{restaurantId}/{tableNumber}` (this project's established `/v1` versioning, not `/api`) encoding a **different** URL, deliberately: see below.

### GET `/v1/qr/{restaurantId}/{tableNumber}`
Returns a PNG QR code image for a table, generated on the fly (no image storage/CDN is configured yet — `AWS_S3_*` in `.env.example` are still placeholders — so nothing is cached as a hosted file). Behind `authenticate` + `authorize('manage_tables')` (manager/owner/system_admin, new permission — see `SNAPORDER_AUTHORIZATION.md` Part 1) — this is a staff setup/printing action, not guest-facing.

**Deliberate deviation from the literal request:** the QR encodes `https://snaporder.app/scan?code={tables.qr_code_unique_id}` (the same random, unguessable per-table token migration 001 already defined, and the target of the tested `POST /v1/tables/{qrCodeId}/scan` flow) — **not** `?r={restaurantId}&t={tableNumber}`. Table numbers are small sequential integers; encoding one directly in the guest-facing link would make every other table at a restaurant trivially guessable by incrementing `t`. `restaurantId`/`tableNumber` stay in this endpoint's own URL (fine — it's staff-only, used to look up and print a table's code), but what the QR image itself points guests to uses the opaque token instead.

The resulting link is also saved to `tables.qr_code_url` ("store QR metadata in database") — a cheap idempotent write, since it's deterministic from the table's own stable `qr_code_unique_id`, not a growing history.

**Response:** `Content-Type: image/png`, 400×400 PNG body. **Response (404)** if no such table at that restaurant.

**Frontend side implemented (2026-09-18):** `frontend/src/pages/ScanPage.jsx`, the app's first real page — `/scan?code={qr_code_unique_id}` (exactly the link the QR above encodes). Requests the guest's location, calls `POST /v1/tables/:qrCodeId/scan`, then `GET /v1/guest/session` + `GET /v1/restaurants/:id` in parallel to "pre-fill" restaurant name, table number, and assigned server, and applies the restaurant's white-label colors/name (`frontend/src/theme.js`) — verified live by replaying the exact same 3-call sequence against a seeded restaurant/table/assigned-staff fixture, including both real error paths (too far away, invalid code). **Not built:** anything past that confirmation screen (menu browsing, cart, ordering) — this was scoped to exactly the scan→pre-fill flow, not the full guest ordering UI.

---

## Guest Health Profiles

### POST `/guest-profiles`
Create/update guest health profile (on first order).

**Request:**
```json
{
  "phone_number": "+234 811 234 5678",
  "guest_name": "Adeola K.",
  "allergies": ["peanuts", "shellfish"],
  "health_goals": ["low_calorie", "high_protein"],
  "is_vegan": false,
  "is_vegetarian": false,
  "is_gluten_free": false,
  "spice_level": "medium"
}
```

**Response (201/200):**
```json
{
  "id": "guest_uuid",
  "phone_number": "+234 811 234 5678",
  "guest_name": "Adeola K.",
  "allergies": ["peanuts", "shellfish"],
  "health_goals": ["low_calorie", "high_protein"],
  "total_orders": 5,
  "last_order_at": "2025-09-15T18:45:00Z"
}
```

---

### GET `/guest-profiles/{guestId}`
Get guest profile (used for recommendations).

**Response (200):** Guest profile object

---

## Reviews & Feedback

### POST `/orders/{orderId}/reviews`
Submit meal reviews (guest).

**Request:**
```json
{
  "meal_id": "meal_uuid",
  "rating": 5,
  "review_text": "Amazing! Fresh and flavorful.",
  "photo_base64": "data:image/jpeg;base64,...",  // Optional
  "has_allergen_issue": false,
  "allergen_issue_description": null
}
```

**Response (201):**
```json
{
  "id": "review_uuid",
  "meal_id": "meal_uuid",
  "rating": 5,
  "review_text": "Amazing! Fresh and flavorful.",
  "photo_url": "https://snaporder-cdn.s3.../review-123.jpg",
  "is_public": true,
  "created_at": "2025-09-16T14:30:00Z"
}
```

---

### GET `/meals/{mealId}/reviews`
Get all reviews for a meal (shown in menu).

**Query Params:**
- `limit=5` — Most recent 5 reviews
- `sort_by=helpful` — Sort by helpfulness

**Response (200):**
```json
{
  "data": [
    {
      "id": "review_uuid",
      "guest_name": "Adeola K.",
      "rating": 5,
      "review_text": "Amazing!",
      "photo_url": "...",
      "helpful_count": 7,
      "posted_at": "2025-09-15T14:20:00Z",
      "restaurant_response": {
        "text": "Thank you! We're glad you enjoyed it.",
        "posted_at": "2025-09-15T16:00:00Z"
      }
    }
  ]
}
```

---

### POST `/reviews/{reviewId}/respond`
Restaurant response to review.

**Request:**
```json
{
  "response_text": "Thank you for the feedback! We're always improving."
}
```

**Response (201):** Restaurant response object

---

## Analytics Dashboard

### GET `/v1/restaurants/{restaurantId}/analytics/daily`
Implemented (2026-09-17) — `backend/src/models/analyticsModel.js`, `backend/src/controllers/analyticsController.js`. Behind `authenticate` + `authorize('view_restaurant_analytics')` — **manager/owner/system_admin** per the existing permission matrix. (Requested as "owner only"; built against the already-tested matrix instead of narrowing it for this one endpoint, since a manager legitimately needs to see how their own shift/day performed too.) Cancelled orders/items are excluded from every figure — a cancelled order was never actually served.

**Query Params:**
- `date=2025-09-16` — Optional, defaults to today
- `days=7` — Widens the window to `[date, date+days)`. **Not built:** a per-day breakdown across that window (that's the still-unbuilt `/analytics/revenue` endpoint below) — `days>1` here returns one aggregate over the whole range.

**Response (200):**
```json
{
  "date": "2025-09-16",
  "days": 1,
  "metrics": {
    "total_orders": 42,
    "total_revenue": 142500,
    "average_order_value": 3393,
    "meals_sold": 67,
    "top_meals": [
      {
        "meal_id": "uuid",
        "name": "Jollof Rice",
        "quantity_sold": 12,
        "revenue": 30000
      }
    ],
    "customer_health_trends": {
      "low_calorie_orders": 18,
      "high_protein_orders": 22,
      "vegan_orders": 5
    },
    "average_prep_time_minutes": 14,
    "guest_satisfaction_rating": 4.3
  }
}
```

---

### GET `/restaurants/{restaurantId}/analytics/revenue`
Revenue reports (daily, weekly, monthly).

**Query Params:**
- `period=monthly` — "daily", "weekly", "monthly", "yearly"
- `start_date=2025-09-01`
- `end_date=2025-09-30`

**Response (200):**
```json
{
  "period": "monthly",
  "start_date": "2025-09-01",
  "end_date": "2025-09-30",
  "summary": {
    "total_revenue": 2850000,
    "average_daily_revenue": 95000,
    "total_orders": 840,
    "average_order_value": 3393
  },
  "breakdown_by_day": [
    {
      "date": "2025-09-16",
      "revenue": 142500,
      "orders": 42
    }
  ]
}
```

---

## Kitchen Display System (KDS)

Implemented (2026-09-17) — `backend/src/realtime.js`, using Socket.io (already a project dependency), attached to the same HTTP server Express runs on. **Supersedes the draft above this line** (a raw-WebSocket sketch with a `wss://.../ws/kitchen/{restaurantId}` URL and client→server write messages) — real differences, both deliberate:

1. **Room-based, not a per-restaurant URL.** A client connects once to the default namespace, authenticates via `socket.handshake.auth.token` (the same JWTs as the REST API — staff or guest), and the server joins it to the relevant room(s) server-side. A guest is joined to `table:{tableId}` automatically from their session; staff must emit `join_kitchen` with `{ restaurantId }` after connecting, which re-runs the same ownership/role checks as `authorize('view_all_orders')` (not embedded in the token, resolved fresh — same reasoning as the HTTP API throughout this project).
2. **Broadcast-only — not a second write path.** The original draft had the kitchen client send `update_item_status`/`order_ready` messages *to* the server. That's not implemented as socket messages: the only way to actually change an order's or item's status is still the existing REST `PATCH` endpoints (`SNAPORDER_AUTHORIZATION.md`-enforced, state-machine validated). Sockets exist purely to broadcast *after* one of those writes commits. Rebuilding that validation a second time as socket handlers would mean two places that could disagree about what transitions are legal.

### Connecting

```js
import { io } from 'socket.io-client';
const socket = io('https://api.snaporder.ng', { auth: { token: accessTokenOrGuestSessionToken } });
```

No token, or an invalid/expired one, gets an `error` event (`{ message }`) and an immediate disconnect. A valid connection gets a `connected` event: `{ role: 'guest', table_id }` or `{ role: 'staff' }`.

### `join_kitchen` (staff only, client → server, with ack)

```js
socket.emit('join_kitchen', { restaurantId }, (result) => { /* { ok: true, restaurant_id } or { ok: false, error } */ });
```
Denial reasons mirror `authorize()`'s: `"You have no role at this restaurant"`, `"Your access to this restaurant has been deactivated"`, or `"Role '{role}' cannot 'view_all_orders'"`.

### Server → client events

**`new_order`** — to the `kitchen:{restaurantId}` room only, right after `POST /v1/orders` commits:
```json
{
  "order_id": "uuid",
  "order_number": "ORD-2026-00147",
  "table_number": 7,
  "items": [
    { "id": "item_uuid", "meal_name": "Amala", "quantity": 2, "priority": "normal" }
  ],
  "placed_at": "2026-09-17T18:17:52.411Z"
}
```
`priority` is `"high"` when that item's `allergen_caution_acknowledged` was true (a guest confirmed a cross-contamination risk to remove an ingredient) — a narrower signal than the original draft's more general "allergen" priority, but a real, non-speculative one already tracked by the order data.

**`order_status_updated`** — to both `kitchen:{restaurantId}` and `table:{tableId}`, after `PATCH /v1/restaurants/{restaurantId}/orders/{orderId}/status` succeeds:
```json
{ "order_id": "uuid", "status": "confirmed" }
```

**`item_status_updated`** — to the same two rooms, after `PATCH .../items/{itemId}/status` succeeds:
```json
{ "order_id": "uuid", "item_id": "uuid", "status": "preparing" }
```

Verified live end-to-end: a kitchen socket and a guest socket both correctly received all three broadcast events with accurate data (including `table_number` resolved from the table id, and `prepared_by_staff_id` correctly recorded on the underlying REST response); a connection with no token was rejected; `join_kitchen` for a restaurant the caller has no role at was denied with the expected message.

---

## Errors

All errors follow this format:

**Response (4xx, 5xx):**
```json
{
  "error": {
    "code": "INVALID_REQUEST",
    "message": "Customer phone number is required",
    "details": {
      "field": "phone_number",
      "reason": "required"
    }
  }
}
```

**Common Error Codes:**
- `INVALID_REQUEST` (400) — Malformed request
- `UNAUTHORIZED` (401) — Missing/invalid token
- `FORBIDDEN` (403) — Insufficient permissions
- `NOT_FOUND` (404) — Resource not found
- `CONFLICT` (409) — Duplicate/conflicting resource
- `INTERNAL_ERROR` (500) — Server error
- `RATE_LIMITED` (429) — Too many requests

---

## Rate Limiting

Implemented via `express-rate-limit` in `backend/src/middleware/rateLimit.js` (as of 2026-09-17). Two limiters, both keyed per-IP:

- **General** (`generalLimiter`, applied to the whole API): 300 requests / 15 min. Skips `/health`.
- **Auth** (`authLimiter`, applied to `/v1/auth/*`): 10 *failed* attempts / 15 min. Successful requests don't count against it, so a legitimate user's own logins never trigger it — only repeated failures do.

**Headers in Response** — IETF draft-7 (`standardHeaders: 'draft-7'`), not the older `X-RateLimit-*` style:
```
RateLimit: limit=300, remaining=299, reset=900
RateLimit-Policy: 300;w=900
```
`reset` and the `w` (window) value are both in seconds. When a limit is hit, the response is `429` with the standard error body (`RATE_LIMITED`, see above).

Rate-limit state is in-memory (the library's default store) — correct for a single backend instance. If this ever runs as multiple instances behind a load balancer, it needs a shared store (e.g. Redis, already a project dependency) so the limit is enforced across instances rather than reset per-instance.

---

**API Version:** 1.8 — Kitchen Display System implemented for real (Socket.io, room-based, broadcast-only) — supersedes the earlier raw-WebSocket draft; `restaurants`/`menus`/`orders` also migrated from routes-only to a models/controllers/routes split (no change to any request/response contract in this document — verified live)
**Last Updated:** Sept 17, 2026  
**Status:** Ready for implementation  
**Protocol:** REST with WebSocket for KDS
