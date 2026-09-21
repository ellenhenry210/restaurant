# SnapOrder Database Schema

## Database: PostgreSQL

**Design Principle:** Relational model, normalized to 3NF, with thoughtful indexes for real-time queries.

**A note on `ENUM(...)` in this doc:** it's used below as design shorthand for "this column only allows these values" — Postgres has no MySQL-style inline `ENUM(...)` column syntax, so this isn't literal runnable SQL. The actual migration (`backend/database/migrations/001_initial_schema.sql`, applied via `npm run migrate`) implements every one of these as `VARCHAR` + a named `CHECK` constraint instead — easier to extend later (no `ALTER TYPE` needed to add a value) than a native Postgres enum type, which matters given the `role` values here have already been renamed once. That migration is the source of truth for what's actually running; this doc is the readable reference.

---

## Core Tables

### 1. `restaurants`
Restaurants using SnapOrder.

```sql
CREATE TABLE restaurants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  description TEXT,
  email VARCHAR(255) UNIQUE NOT NULL,
  phone VARCHAR(20),
  address VARCHAR(500),
  city VARCHAR(100),
  state VARCHAR(100),
  country VARCHAR(100) DEFAULT 'Nigeria',
  
  -- Business details
  registration_number VARCHAR(50) UNIQUE,  -- RC number (Eden Acres: RC 9597708)
  tax_id VARCHAR(50),
  
  -- Customization (White-label)
  logo_url TEXT,
  primary_color VARCHAR(7),  -- Hex color
  secondary_color VARCHAR(7),
  custom_domain VARCHAR(255),
  
  -- Billing
  plan_type ENUM('free', 'basic', 'premium', 'enterprise') DEFAULT 'free',
  subscription_start_date DATE,
  subscription_end_date DATE,
  
  -- Guest proximity gating (migration 003, 2026-09-17) — see table 20,
  -- `guest_sessions`, and SNAPORDER_AUTHORIZATION.md Part 2 condition 6.
  -- NULL lat/long means guest ordering is unavailable at this restaurant
  -- (fails closed, not open) until it's configured.
  latitude DECIMAL(9, 6),
  longitude DECIMAL(9, 6),
  max_guest_distance_meters INT NOT NULL DEFAULT 150,
  
  -- Operational
  timezone VARCHAR(50) DEFAULT 'Africa/Lagos',
  -- Weekly schedule (migration 006, 2026-09-17), JSONB rather than a
  -- separate table — see that migration for why. Shape:
  -- {"monday": {"open": "09:00", "close": "22:00"}, ..., "sunday": null}
  -- (null/absent = closed that day). No write endpoint yet.
  opening_hours JSONB,
  -- Per-restaurant, not a global constant (migration 008, 2026-09-17) —
  -- stored as a fraction (0.075 = 7.5%) so applying it is a plain
  -- multiplication. Default 0: a restaurant's total is never silently
  -- inflated by an assumed rate it never configured.
  tax_rate DECIMAL(5, 4) NOT NULL DEFAULT 0,
  service_charge_rate DECIMAL(5, 4) NOT NULL DEFAULT 0,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT valid_colors CHECK (
    primary_color ~* '^#[0-9A-Fa-f]{6}$' OR primary_color IS NULL
  ),
  CONSTRAINT chk_restaurants_lat CHECK (latitude IS NULL OR (latitude BETWEEN -90 AND 90)),
  CONSTRAINT chk_restaurants_lon CHECK (longitude IS NULL OR (longitude BETWEEN -180 AND 180)),
  CONSTRAINT chk_restaurants_max_distance CHECK (max_guest_distance_meters > 0),
  CONSTRAINT chk_restaurants_tax_rate CHECK (tax_rate BETWEEN 0 AND 1),
  CONSTRAINT chk_restaurants_service_charge_rate CHECK (service_charge_rate BETWEEN 0 AND 1)
);

CREATE INDEX idx_restaurants_email ON restaurants(email);
CREATE INDEX idx_restaurants_custom_domain ON restaurants(custom_domain);
```

---

### 2. `restaurant_staff`
Staff members with roles. Role values and what each can do are the RBAC layer defined in `SNAPORDER_AUTHORIZATION.md` — see that doc for the full permission matrix and the ABAC conditions layered on top (e.g. `restaurant_id` ownership scoping applies to every query against this table and everything it relates to). Login credentials live separately, on **table 19, `users`** — this table only holds a person's restaurant-scoped role assignment; see that section for why they're split.

```sql
CREATE TABLE restaurant_staff (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,
  -- Customizable, guest-facing name (migration 009, 2026-09-17) —
  -- explicit user request: "I want the name to be customizable as well."
  -- NULL means "just show `name`"; a staff member isn't forced to set
  -- one. Shown to guests via table_assignments (table 22), never `name`
  -- directly once display_name is set.
  display_name VARCHAR(255),
  phone VARCHAR(20),
  
  role ENUM('waiter', 'kitchen_staff', 'manager', 'owner') NOT NULL,
  
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT unique_user_per_restaurant UNIQUE (restaurant_id, user_id)
);

CREATE INDEX idx_staff_restaurant ON restaurant_staff(restaurant_id);
CREATE INDEX idx_staff_role ON restaurant_staff(restaurant_id, role);
CREATE INDEX idx_staff_user ON restaurant_staff(user_id);
```

Notes:
- Supersedes an earlier draft of this table that used `('manager', 'chef', 'waiter', 'inventory_manager')`. Renamed `chef` → `kitchen_staff` and folded `inventory_manager` into `manager` to match the 6-role platform-wide hierarchy in `SNAPORDER_AUTHORIZATION.md` (Guest → Waiter → Kitchen Staff → Manager → Owner → System Admin). System Admin is platform-level, not restaurant-scoped, so it belongs in a separate `platform_admins` table — not yet created (see Authorization doc, Part 6).
- Migration 002 (2026-09-17) replaced this table's own `email` column + `unique_restaurant_email` constraint with `user_id` (FK to `users`) + `unique_user_per_restaurant`. One `users` row can now have multiple `restaurant_staff` rows — e.g. an Owner at more than one restaurant — without duplicating (and risking drift on) their password hash across rows.

---

### 3. `tables` (Physical Tables)
Physical restaurant tables with QR codes.

```sql
CREATE TABLE tables (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  
  table_number INT NOT NULL,
  qr_code_unique_id VARCHAR(100) NOT NULL,  -- Maps QR to table
  qr_code_url TEXT,  -- Generated QR image
  
  capacity INT,  -- Seats
  location VARCHAR(255),  -- "Corner", "Window", "VIP area"
  
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT unique_table_number UNIQUE (restaurant_id, table_number),
  CONSTRAINT unique_qr_code UNIQUE (qr_code_unique_id)
);

CREATE INDEX idx_tables_restaurant ON tables(restaurant_id);
CREATE INDEX idx_tables_qr_code ON tables(qr_code_unique_id);
```

---

### 4. `menus`
Menu configurations per restaurant.

```sql
CREATE TABLE menus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,  -- "Lunch Menu", "Dinner Menu"
  description TEXT,
  
  is_active BOOLEAN DEFAULT TRUE,
  active_from TIME,  -- Menu available from 12:00 PM
  active_until TIME,  -- Menu available until 10:00 PM
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_menus_restaurant ON menus(restaurant_id);
CREATE INDEX idx_menus_active ON menus(restaurant_id, is_active);
```

---

### 5. `meal_categories`
Meal categories (Breakfast, Main Course, Desserts, etc.).

```sql
CREATE TABLE meal_categories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  menu_id UUID NOT NULL REFERENCES menus(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,  -- "Main Course"
  description TEXT,
  icon_emoji VARCHAR(10),  -- "🍲"
  sort_order INT DEFAULT 0,
  
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_categories_menu ON meal_categories(menu_id);
```

---

### 6. `meals`
Individual meal items.

```sql
CREATE TABLE meals (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id UUID NOT NULL REFERENCES meal_categories(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,  -- "Grilled Chicken Rice"
  description TEXT,
  image_url TEXT,
  
  -- Pricing
  base_price DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',
  
  -- Nutritional Info
  calories INT,
  protein_grams DECIMAL(5, 1),
  carbs_grams DECIMAL(5, 1),
  fat_grams DECIMAL(5, 1),
  fiber_grams DECIMAL(5, 1),
  sodium_mg INT,
  
  -- Health tags
  is_vegan BOOLEAN DEFAULT FALSE,
  is_vegetarian BOOLEAN DEFAULT FALSE,
  is_gluten_free BOOLEAN DEFAULT FALSE,
  is_low_calorie BOOLEAN DEFAULT FALSE,  -- < 500 cal
  is_high_protein BOOLEAN DEFAULT FALSE,  -- > 25g protein
  
  -- Availability
  is_available BOOLEAN DEFAULT TRUE,
  estimated_prep_time_minutes INT,  -- How long to prepare
  
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_meals_category ON meals(category_id);
CREATE INDEX idx_meals_restaurant ON meals(restaurant_id);
CREATE INDEX idx_meals_available ON meals(restaurant_id, is_available);
CREATE INDEX idx_meals_health_tags ON meals(is_vegan, is_vegetarian, is_gluten_free);
```

---

### 7. `ingredients`
Individual ingredients used in meals.

```sql
CREATE TABLE ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,  -- "Chicken breast", "Rice"
  
  -- Allergen info
  allergen_type ENUM(
    'peanuts', 'tree_nuts', 'shellfish', 'fish',
    'milk', 'eggs', 'soy', 'wheat', 'sesame',
    'sulfites', 'mustard', 'celery', 'none'
  ) DEFAULT 'none',
  
  is_allergen BOOLEAN DEFAULT FALSE,
  
  -- Stock tracking
  current_stock INT DEFAULT 0,
  unit_of_measure VARCHAR(50),  -- "kg", "liter", "pieces"
  reorder_level INT,  -- Alert when stock < this
  
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_ingredients_restaurant ON ingredients(restaurant_id);
CREATE INDEX idx_ingredients_allergen ON ingredients(allergen_type);
```

---

### 8. `meal_ingredients`
Mapping of ingredients to meals (many-to-many with options). This is also where the allergen ingredient-removal policy lives — see `SNAPORDER_AUTHORIZATION.md` Part 3 for the full guest/manager/kitchen flow this powers.

```sql
CREATE TABLE meal_ingredients (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_id UUID NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  ingredient_id UUID NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  
  -- Customization / allergen removal policy (manager-set; see SNAPORDER_AUTHORIZATION.md)
  removal_policy ENUM('can_remove', 'caution', 'cannot_remove') DEFAULT 'can_remove',
  removal_policy_reason TEXT,  -- shown to guest for 'caution' and 'cannot_remove'
  is_required BOOLEAN DEFAULT FALSE,  -- Must this ingredient be in meal?
  
  quantity DECIMAL(8, 2),  -- How much of ingredient in base meal
  unit_of_measure VARCHAR(50),  -- "grams", "ml", "pieces"
  
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT unique_meal_ingredient UNIQUE (meal_id, ingredient_id)
);

CREATE INDEX idx_meal_ingredients_meal ON meal_ingredients(meal_id);
```

Note: supersedes an earlier draft that used a plain `can_be_removed BOOLEAN`. The 3-state `removal_policy` replaces it so a restaurant can distinguish "safe to remove" from "removable but risky — guest must acknowledge" from "cannot be safely removed" (default is the permissive `can_remove`; a manager opts specific ingredients into `caution`/`cannot_remove`).

---

### 9. `meal_addons`
Optional add-ons (extra protein, extra sauce, etc.).

```sql
CREATE TABLE meal_addons (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meal_id UUID NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  
  name VARCHAR(255) NOT NULL,  -- "Extra Chicken", "Extra Sauce"
  description TEXT,
  
  additional_price DECIMAL(10, 2) NOT NULL,  -- + ₦800
  
  max_quantity INT DEFAULT 1,  -- How many can guest add?
  
  is_available BOOLEAN DEFAULT TRUE,
  sort_order INT DEFAULT 0,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_addons_meal ON meal_addons(meal_id);
```

---

### 10. `guest_profiles`
Guest health/dietary profiles.

```sql
CREATE TABLE guest_profiles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  
  phone_number VARCHAR(20) NOT NULL,  -- Primary identifier (Nigerian phone)
  guest_name VARCHAR(255),
  
  -- Allergies
  allergies TEXT[],  -- Array: ['peanuts', 'shellfish', 'milk']
  
  -- Health goals
  health_goals TEXT[],  -- Array: ['low_calorie', 'high_protein', 'vegan']
  
  -- Dietary restrictions
  is_vegan BOOLEAN DEFAULT FALSE,
  is_vegetarian BOOLEAN DEFAULT FALSE,
  is_gluten_free BOOLEAN DEFAULT FALSE,
  
  -- Preferences
  spice_level ENUM('mild', 'medium', 'hot') DEFAULT 'medium',
  
  -- Engagement
  total_orders INT DEFAULT 0,
  last_order_at TIMESTAMP,
  
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  
  CONSTRAINT unique_guest_per_restaurant UNIQUE (restaurant_id, phone_number)
);

CREATE INDEX idx_guest_profiles_phone ON guest_profiles(phone_number);
CREATE INDEX idx_guest_profiles_restaurant ON guest_profiles(restaurant_id);
```

---

### 11. `orders`
Guest orders. `order_number` values (e.g. `ORD-2026-00147`) are generated from `order_number_seq` (migration 007, 2026-09-17) — `SELECT nextval('order_number_seq')`, not `COUNT(*) + 1`, since a count-based scheme races under concurrent order placement (a `SEQUENCE` is atomic across concurrent transactions; a count isn't). Simplification worth knowing: the sequence does not reset each year — the year in the number is just whatever year it is at issue time, so numbering continues past `00999` into the next year rather than restarting at `00001`.

`tax`/`service_charge`/`total_amount` are computed at order-creation time (`backend/src/routes/orders.js`) from `restaurants.tax_rate`/`service_charge_rate` (migration 008) — `total_amount = subtotal + tax + service_charge`, each rounded to 2dp *before* summing (not after), so the stored figures always add up exactly on a receipt. `tip_amount` is guest-supplied and optional, deliberately excluded from `total_amount` (a receipt reads "Total: X, tip at your discretion," not one number silently including it) — the actual amount owed is `total_amount + tip_amount`, returned as `grand_total` in API responses but not its own stored column.

```sql
CREATE TABLE orders (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE SET NULL,
  guest_profile_id UUID REFERENCES guest_profiles(id) ON DELETE SET NULL,
  
  order_number VARCHAR(50) UNIQUE NOT NULL,  -- "ORD-2025-00147"
  
  -- Status
  status ENUM(
    'placed', 'confirmed', 'preparing', 
    'ready', 'served', 'cancelled'
  ) DEFAULT 'placed',
  
  -- Timing
  placed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  confirmed_at TIMESTAMP,
  ready_at TIMESTAMP,
  served_at TIMESTAMP,
  cancelled_at TIMESTAMP,
  
  estimated_ready_time INT,  -- Minutes from placement
  
  -- Pricing
  subtotal DECIMAL(10, 2),
  tax DECIMAL(10, 2),
  service_charge DECIMAL(10, 2),
  total_amount DECIMAL(10, 2),
  currency VARCHAR(3) DEFAULT 'NGN',
  
  -- Payment
  payment_status ENUM('pending', 'completed', 'failed') DEFAULT 'pending',
  payment_method ENUM('card', 'bank_transfer', 'mobile_money', 'cash') DEFAULT 'cash',
  payment_reference VARCHAR(255),
  
  -- Tipping
  tip_amount DECIMAL(10, 2),
  
  -- Special notes
  special_requests TEXT,
  allergen_warnings TEXT,  -- Stored for safety
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_orders_restaurant ON orders(restaurant_id);
CREATE INDEX idx_orders_table ON orders(table_id);
CREATE INDEX idx_orders_status ON orders(restaurant_id, status);
CREATE INDEX idx_orders_date ON orders(placed_at);
CREATE INDEX idx_orders_guest ON orders(guest_profile_id);
```

---

### 12. `order_items`
Individual items in an order (many meals per order).

```sql
CREATE TABLE order_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  meal_id UUID NOT NULL REFERENCES meals(id),
  
  meal_name VARCHAR(255),  -- Snapshot of meal name
  meal_price DECIMAL(10, 2),  -- Price at time of order
  quantity INT DEFAULT 1,
  
  -- Customization snapshot
  removed_ingredients UUID[],  -- Array of ingredient IDs removed
  allergen_caution_acknowledged BOOLEAN DEFAULT FALSE,  -- Guest confirmed a 'caution'-level removal (see SNAPORDER_AUTHORIZATION.md Part 3)
  added_addons UUID[],  -- Array of addon IDs added
  special_request TEXT,  -- "No oil", "Extra spicy"
  
  -- Status
  status ENUM(
    'pending', 'preparing', 
    'ready', 'served', 'cancelled'
  ) DEFAULT 'pending',
  
  prepared_by_staff_id UUID REFERENCES restaurant_staff(id),
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_order_items_order ON order_items(order_id);
CREATE INDEX idx_order_items_meal ON order_items(meal_id);
```

---

### 13. `guest_reviews`
Guest reviews and feedback.

```sql
CREATE TABLE guest_reviews (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  meal_id UUID NOT NULL REFERENCES meals(id) ON DELETE CASCADE,
  guest_profile_id UUID NOT NULL REFERENCES guest_profiles(id) ON DELETE CASCADE,
  
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),  -- 1-5 stars, enforced
  review_text TEXT,  -- Optional written review
  photo_url TEXT,  -- Optional meal photo
  
  -- Issue flags
  has_allergen_issue BOOLEAN DEFAULT FALSE,
  allergen_issue_description TEXT,
  
  -- Helpfulness
  helpful_count INT DEFAULT 0,
  
  is_public BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_reviews_meal ON guest_reviews(meal_id);
CREATE INDEX idx_reviews_guest ON guest_reviews(guest_profile_id);
CREATE INDEX idx_reviews_public ON guest_reviews(is_public);
```

---

### 14. `restaurant_responses`
Restaurant responses to guest reviews.

```sql
CREATE TABLE restaurant_responses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  review_id UUID NOT NULL REFERENCES guest_reviews(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES restaurant_staff(id),
  
  response_text TEXT NOT NULL,
  
  is_public BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_responses_review ON restaurant_responses(review_id);
```

---

### 15. `feature_suggestions`
Community-suggested features with voting.

```sql
CREATE TABLE feature_suggestions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  
  title VARCHAR(255) NOT NULL,
  description TEXT,
  
  category ENUM('guest', 'restaurant', 'both') DEFAULT 'both',
  
  upvote_count INT DEFAULT 0,
  is_implemented BOOLEAN DEFAULT FALSE,
  implemented_date DATE,
  
  created_by_guest_id UUID REFERENCES guest_profiles(id) ON DELETE SET NULL,
  created_by_staff_id UUID REFERENCES restaurant_staff(id) ON DELETE SET NULL,
  
  status ENUM('proposed', 'planned', 'in_progress', 'completed') DEFAULT 'proposed',
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_suggestions_status ON feature_suggestions(status);
CREATE INDEX idx_suggestions_upvotes ON feature_suggestions(upvote_count DESC);
```

---

### 16. `suggestions_votes`
Guest/staff votes on feature suggestions.

```sql
CREATE TABLE suggestions_votes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  suggestion_id UUID NOT NULL REFERENCES feature_suggestions(id) ON DELETE CASCADE,
  
  voted_by_guest_id UUID REFERENCES guest_profiles(id) ON DELETE SET NULL,
  voted_by_staff_id UUID REFERENCES restaurant_staff(id) ON DELETE SET NULL,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_vote_single_voter CHECK (
    (voted_by_guest_id IS NOT NULL AND voted_by_staff_id IS NULL)
    OR (voted_by_guest_id IS NULL AND voted_by_staff_id IS NOT NULL)
  )
);

CREATE INDEX idx_votes_suggestion ON suggestions_votes(suggestion_id);

-- NOT a single 3-column UNIQUE (suggestion_id, voted_by_guest_id, voted_by_staff_id):
-- Postgres treats NULL as distinct from NULL in uniqueness checks, so that
-- constraint would never actually block the same guest voting twice (their
-- voted_by_staff_id is NULL both times). Two partial unique indexes instead:
CREATE UNIQUE INDEX unique_guest_vote_per_suggestion
  ON suggestions_votes(suggestion_id, voted_by_guest_id)
  WHERE voted_by_guest_id IS NOT NULL;

CREATE UNIQUE INDEX unique_staff_vote_per_suggestion
  ON suggestions_votes(suggestion_id, voted_by_staff_id)
  WHERE voted_by_staff_id IS NOT NULL;
```

---

### 17. `audit_log`
Audit trail for all critical actions.

```sql
CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID,  -- nullable, and NOT a foreign key: see note below
  
  action ENUM(
    'order_placed', 'order_cancelled', 'menu_updated',
    'inventory_updated', 'review_posted', 'staff_login',
    'authz_denied'  -- Logged authorization failure; see SNAPORDER_AUTHORIZATION.md Part 5
  ) NOT NULL,
  
  actor_type ENUM('guest', 'staff', 'system') DEFAULT 'system',
  actor_id UUID,  -- Reference to guest or staff
  
  resource_type VARCHAR(100),  -- 'order', 'meal', 'guest', etc.
  resource_id UUID,
  
  changes JSONB,  -- What changed: {before: {}, after: {}}
  ip_address INET,
  
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_restaurant ON audit_log(restaurant_id);
CREATE INDEX idx_audit_date ON audit_log(created_at);
CREATE INDEX idx_audit_platform ON audit_log(action) WHERE restaurant_id IS NULL;
```

Note: `restaurant_id` was originally `NOT NULL` — migration 005 (2026-09-17) relaxed it. Adding `platform_admins` (table 21) meant a denied System Admin check has no single restaurant to attach to; `NULL` here specifically means "a platform-level action, not scoped to any restaurant," not "unknown."

Note: `restaurant_id` was originally a hard `REFERENCES restaurants(id) ON DELETE CASCADE` too — migration 011 (2026-09-17) dropped that FK, for two reasons found via a live Postgres error log: (1) `ON DELETE CASCADE` meant deleting a restaurant destroyed its own audit history along with it, the opposite of what an audit trail is for; (2) `authorize()`'s denial path (`middleware/authorize.js`) logs every failed authorization attempt using whatever `restaurantId` is in the request URL — including a well-formed UUID that doesn't correspond to a real restaurant, exactly the shape of a tenant-enumeration probe. That write failed the FK check every time, and `logAudit()` (`audit.js`) deliberately swallows its own errors so a logging bug can never break a real request — meaning this entire category of denial was invisible everywhere except ephemeral console output, never in this table, where Part 5 requires it to be. `restaurant_id` is now a soft reference: still useful for joins when it happens to be a real, live restaurant, but no longer enforced or cascaded.

---

### 18. `shifts`
Staff clock-in/clock-out records. This is the session-context data that ABAC condition #4 in `SNAPORDER_AUTHORIZATION.md` (Part 2) needs — e.g. scoping the kitchen queue to staff who are actually clocked in, rather than every kitchen staff member who has ever worked at the restaurant.

```sql
CREATE TABLE shifts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES restaurant_staff(id) ON DELETE CASCADE,

  clock_in TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  clock_out TIMESTAMP,  -- NULL while the shift is still active

  role_during_shift ENUM('waiter', 'kitchen_staff', 'manager', 'owner') NOT NULL,
  -- Snapshot of restaurant_staff.role at clock-in time, so a later role
  -- change doesn't retroactively change what this shift was authorized for.

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT valid_shift_times CHECK (clock_out IS NULL OR clock_out > clock_in)
);

CREATE INDEX idx_shifts_staff ON shifts(staff_id);

-- High-traffic query: "who is currently clocked in at this restaurant?"
CREATE INDEX idx_shifts_restaurant_active ON shifts(restaurant_id) WHERE clock_out IS NULL;

-- A staff member can only have one active (not-yet-clocked-out) shift at a time.
CREATE UNIQUE INDEX unique_active_shift_per_staff ON shifts(staff_id) WHERE clock_out IS NULL;
```

---

### 19. `users`
Login identity — email + password — independent of any restaurant. Added in migration 002 (2026-09-17), after the initial schema; referenced by `restaurant_staff.user_id` (table 2) despite the higher number here, since it was added later, not because it's less foundational. Guests are deliberately **not** in this table — no password, identified by phone number only (`guest_profiles`, table 10).

```sql
CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) UNIQUE NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_users_email ON users(email);
```

Implementation notes (`backend/src/routes/auth.js`):
- `password_hash` is a bcrypt hash (`bcryptjs`, cost factor 12), written with the async `bcrypt.hash()`/`bcrypt.compare()` — never the `*Sync` variants, which would block Node's single event loop thread for the ~100ms+ a hash takes, stalling every other in-flight request on the server.
- Registration and login return the same generic "Invalid email or password" on any failure (no such email, or wrong password) — distinguishing them would let a client enumerate which emails have accounts.

---

### 20. `guest_sessions`
Issued after a successful proximity check at QR-scan time (migration 003, 2026-09-17) — see `restaurants.latitude`/`longitude`/`max_guest_distance_meters` (table 1) and `SNAPORDER_AUTHORIZATION.md` Part 2 condition 6. Deliberately its own table rather than a bare stateless JWT: it's a real audit trail of exactly where/when each session was granted (useful for security review and spotting abuse like GPS spoofing), and a place to revoke a session early if ever needed.

```sql
CREATE TABLE guest_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  guest_profile_id UUID REFERENCES guest_profiles(id) ON DELETE SET NULL,  -- NULL until the guest actually places an order

  scan_latitude DECIMAL(9, 6) NOT NULL,
  scan_longitude DECIMAL(9, 6) NOT NULL,
  distance_meters DECIMAL(10, 2) NOT NULL,  -- distance at scan time, kept even though the request succeeded

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  expires_at TIMESTAMP NOT NULL,

  CONSTRAINT chk_guest_sessions_lat CHECK (scan_latitude BETWEEN -90 AND 90),
  CONSTRAINT chk_guest_sessions_lon CHECK (scan_longitude BETWEEN -180 AND 180)
);

CREATE INDEX idx_guest_sessions_table ON guest_sessions(table_id);
CREATE INDEX idx_guest_sessions_restaurant ON guest_sessions(restaurant_id);
CREATE INDEX idx_guest_sessions_expires ON guest_sessions(expires_at);
```

Implementation (`backend/src/routes/guestSession.js`, `backend/src/geo.js`, `backend/src/middleware/authGuest.js`):
- `POST /v1/tables/:qrCodeId/scan` computes the Haversine distance between the guest's reported coordinates and the restaurant's, and issues a session (a JWT with `type: 'guest'`, `expires_at` here set to exactly match the JWT's own `exp`) only if within `max_guest_distance_meters`.
- **Fails closed:** a restaurant with `latitude`/`longitude` still `NULL` blocks guest ordering entirely rather than allowing it unchecked.
- `authenticateGuest` re-checks `expires_at` against this row on every request, not just the JWT's own expiry — so a session can be revoked early (e.g. by an operator) by updating this row, taking effect immediately rather than waiting for the JWT to naturally expire. Verified live: setting `expires_at` into the past blocks a token whose JWT signature/exp were still otherwise valid.

---

### 21. `platform_admins`
Backs the System Admin role (migration 004, 2026-09-17) — SnapOrder's own team, platform-level, not scoped to any restaurant. Separate from `restaurant_staff` the same way `restaurant_staff` is separate from `users`: this grants elevated cross-restaurant access on top of an existing `users` identity, it isn't itself a login. A user can be both a platform admin and restaurant staff somewhere (e.g. piloting their own test restaurant) — not mutually exclusive, no constraint links the two.

```sql
CREATE TABLE platform_admins (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  granted_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,  -- accountability (PAM, Part 7); NULL for the first-ever admin

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_platform_admins_user ON platform_admins(user_id);
```

Implementation: `backend/src/middleware/authorizePlatform.js`'s `requirePlatformAdmin(permissionKey)` — the System Admin counterpart to `authorize()` (table 2's notes / `SNAPORDER_AUTHORIZATION.md` Part 4). Verified live (denied, then allowed after inserting a row) in isolation — **no real route uses it yet**, since no platform-level resource (cross-restaurant analytics, roadmap status) exists to protect.

---

### 22. `table_assignments`
Which staff member is currently serving a table (migration 009, 2026-09-17) — explicit user request: "the guest should know the staff that is assigned to serving them." Its own table with history, not a single column overwritten on `tables`, for the same reason `shifts` (table 18) isn't just a flag on `restaurant_staff` — who served a table, and when, is worth keeping.

```sql
CREATE TABLE table_assignments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  staff_id UUID NOT NULL REFERENCES restaurant_staff(id) ON DELETE CASCADE,

  assigned_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  unassigned_at TIMESTAMP,  -- NULL = currently assigned

  CONSTRAINT chk_assignment_times CHECK (unassigned_at IS NULL OR unassigned_at > assigned_at)
);

CREATE INDEX idx_assignments_staff ON table_assignments(staff_id);
CREATE INDEX idx_assignments_table_active ON table_assignments(table_id) WHERE unassigned_at IS NULL;

-- One active assignment per table — reassigning ends the previous one
-- first (backend/src/routes/tables.js), atomically, rather than
-- requiring a separate unassign call.
CREATE UNIQUE INDEX unique_active_assignment_per_table ON table_assignments(table_id) WHERE unassigned_at IS NULL;
```

Implementation: `backend/src/routes/tables.js` (`POST /:tableId/assign`, `POST /:tableId/unassign`, both requiring the `assign_table` permission — Manager/Owner/System Admin). Surfaced to guests via `GET /v1/guest/session` and `GET /v1/orders/:id` (both return a `server: { name, role }` field, preferring `restaurant_staff.display_name` over `name` when set) — verified live, including that reassigning a table correctly updates what a guest sees on their very next request.

---

## Payment & Billing Model (IMPLEMENTED 2026-09-21 — migrations 013-015 + routes/controllers; frontend still to build)

Full spec given by the user 2026-09-21: three payment-timing choices (**Pay Now**, **Pay After**, **Pay Traditionally**), with a **split-the-bill vs. pay-whole** choice under the first two, and a **"Call the waiter/waitress"** action under the third (choosing Pay Traditionally *is* the call — there's no separate button elsewhere).

**Revision note (same day):** the first draft of this design modeled a split as several separate `bills` rows (one per guest, `type: 'per_guest_split'`). A second, independently-drafted proposal (also reviewed 2026-09-21) argued for a cleaner shape — one bill per sitting always, with a split represented as shares *of* that one bill — and that proposal is correct: most real split requests ("split 4 ways evenly," "I'll pay for mine, custom amounts") aren't about who originally ordered what, which the by-guest model implicitly assumed. **This section now reflects the revised, final design** (`bill_splits`/`bill_split_shares`, below) — the by-guest-bills version is gone, not just superseded in place. That second proposal also contained real errors specific to *this* codebase (it assumed a `qr_sessions` table and an `INTEGER restaurants.id` — this project has `guest_sessions` and UUID PKs throughout; it also proposed a new `guests` table duplicating the already-existing `guest_profiles`, and kobo-integer amounts inconsistent with this schema's DECIMAL(10,2) Naira everywhere else) — its structural ideas were adopted, its schema particulars were not copied as-is.

**Why the current implementation can't support this:** `orders` (table 11) is per guest session/scan, and `payment_transactions` (below) is per `order_id` — there is no concept of "everyone currently sitting at this table" above the level of one order, so there's nothing to attach a consolidated ("whole") bill to, and no way to know which orders belong together for a split. Two guests who each scan the same table's QR separately currently produce two completely unrelated orders with no shared identifier at all.

**The missing piece: a table "sitting."** A restaurant POS calls this a "check" being opened when a table is sat — this schema needs the same concept, explicit rather than inferred from timestamps. A sitting is the boundary that says "these orders belong to the same visit, by the same group of guests, at this table" — it's what a bill actually bills.

- A new guest scan (`POST /v1/tables/:qrCodeId/scan`) joins the table's currently **open** sitting if one exists, or opens a new one if the table has none open (i.e. this is the table's first guest since it last turned over). This is the natural, existing signal for "a new group has sat down" — no new guest action needed to trigger it.
- A sitting closes when its bill(s) are fully settled (all `paid` or `settled_traditionally`), or a staff member closes it manually (e.g. guests leave without completing checkout in-app). A closed table can start a fresh sitting on the next scan.
- `guest_sessions` (table 20) and `orders` (table 11) both gain a `sitting_id` FK once this is built — this is how "all orders in this sitting" becomes a plain query instead of a time-window heuristic.

### 23. `payment_transactions` (implemented 2026-09-17, documented here retroactively — was missing from this file)
Records every Paystack initialize attempt, not just successful ones. Currently keyed to `order_id` — **this is exactly the column the design below changes to `bill_id`**, since payment moves from being an order-level concept to a bill-level one.

```sql
CREATE TABLE payment_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,  -- becomes bill_id, see below
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,

  reference VARCHAR(100) NOT NULL,
  amount DECIMAL(10, 2) NOT NULL,
  currency VARCHAR(3) DEFAULT 'NGN',

  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  gateway VARCHAR(20) NOT NULL DEFAULT 'paystack',
  authorization_url TEXT,
  gateway_response JSONB,
  paid_at TIMESTAMP,

  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_payment_transactions_status CHECK (status IN ('pending', 'success', 'failed', 'abandoned')),
  CONSTRAINT unique_payment_reference UNIQUE (reference)
);
```

### 24. `table_sittings` (new — IMPLEMENTED 2026-09-21, migration 013)
One row per "visit" to a table, from first scan since turnover to full settlement. Exists specifically so a bill has something well-defined to bill — see rationale above.

```sql
CREATE TABLE table_sittings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,

  status VARCHAR(20) NOT NULL DEFAULT 'open',
  opened_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP,

  CONSTRAINT chk_sitting_status CHECK (status IN ('open', 'closed')),
  CONSTRAINT chk_sitting_times CHECK (closed_at IS NULL OR closed_at > opened_at)
);

CREATE INDEX idx_sittings_table ON table_sittings(table_id);
CREATE INDEX idx_sittings_restaurant ON table_sittings(restaurant_id);

-- One open sitting per table at a time — mirrors table_assignments'
-- unique_active_assignment_per_table (table 22), same partial-unique-index pattern.
CREATE UNIQUE INDEX unique_open_sitting_per_table ON table_sittings(table_id) WHERE status = 'open';
```

**Required changes to existing tables — added by migration 013, deliberately NULLABLE for now:** `guest_sessions.sitting_id`, `orders.sitting_id`, `orders.bill_id`, `payment_transactions.bill_id` (added *alongside* `payment_transactions.order_id`, which stays — not renamed). Nullable specifically because no route yet populates them (scan, order-creation, and payment-initialize all still need updating to do so) — making them `NOT NULL` now would have broken every currently-passing test and the real running guest flow. They become effectively-required once that route work lands; that's a follow-up code change, not a further schema change. `orders.payment_status`/`payment_method`/`payment_reference` (table 11) become redundant once a bill exists — **superseded by `bills.status`/`bills.timing` below, not duplicated on the order** — but aren't dropped yet either, for the same non-breaking reason.

### 25. `bills` (new — IMPLEMENTED 2026-09-21, migration 013)
The actual payable unit — **exactly one bill per sitting, always** (`UNIQUE (sitting_id)`). A split does not create additional bill rows; see `bill_splits`/`bill_split_shares` below for how a split is represented instead.

```sql
CREATE TABLE bills (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sitting_id UUID NOT NULL REFERENCES table_sittings(id) ON DELETE CASCADE,
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,  -- denormalized, same pattern as payment_transactions

  timing VARCHAR(20) NOT NULL,    -- 'pay_now' | 'pay_after' | 'pay_traditional'
  status VARCHAR(20) NOT NULL DEFAULT 'open',

  subtotal DECIMAL(10, 2) NOT NULL DEFAULT 0,
  tax DECIMAL(10, 2) NOT NULL DEFAULT 0,
  service_charge DECIMAL(10, 2) NOT NULL DEFAULT 0,
  tip_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(10, 2) NOT NULL DEFAULT 0,  -- computed from the sitting's orders at creation time

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  settled_at TIMESTAMP,

  CONSTRAINT chk_bill_timing CHECK (timing IN ('pay_now', 'pay_after', 'pay_traditional')),
  CONSTRAINT chk_bill_status CHECK (status IN ('open', 'split_requested', 'awaiting_payment', 'paid', 'settled_traditionally', 'cancelled')),
  CONSTRAINT unique_bill_per_sitting UNIQUE (sitting_id)
);

CREATE INDEX idx_bills_restaurant ON bills(restaurant_id);
```

### `bill_splits` / `bill_split_shares` (new — IMPLEMENTED 2026-09-21, migration 013)
Created **only** when a guest explicitly requests a split — nothing creates these automatically. Splits the one `bills` row into shares; does not create separate bill rows per guest/party.

```sql
CREATE TABLE bill_splits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  bill_id UUID NOT NULL UNIQUE REFERENCES bills(id) ON DELETE CASCADE,  -- at most one active split per bill

  split_type VARCHAR(10) NOT NULL,  -- 'even' | 'custom' — 'by_item' deferred, needs line-item-level UI
  num_parties INT NOT NULL,

  requested_by_session_id UUID REFERENCES guest_sessions(id) ON DELETE SET NULL,  -- a real FK, not a loose device string
  requested_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT chk_split_type CHECK (split_type IN ('even', 'custom')),
  CONSTRAINT chk_split_parties CHECK (num_parties >= 2)
);

CREATE TABLE bill_split_shares (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  split_id UUID NOT NULL REFERENCES bill_splits(id) ON DELETE CASCADE,

  guest_label VARCHAR(50) NOT NULL,  -- e.g. "Guest 1", or a phone number if one was provided
  amount_owed DECIMAL(10, 2) NOT NULL,
  payment_status VARCHAR(20) NOT NULL DEFAULT 'pending',
  paystack_reference VARCHAR(100),
  paid_at TIMESTAMP,

  CONSTRAINT chk_share_payment_status CHECK (payment_status IN ('pending', 'paid', 'failed'))
);

CREATE INDEX idx_shares_split ON bill_split_shares(split_id);
CREATE UNIQUE INDEX unique_share_paystack_reference ON bill_split_shares(paystack_reference) WHERE paystack_reference IS NOT NULL;
```

**Split semantics, v1:** `even` divides `bills.total_amount` across `num_parties` shares (remainder to the first share); `custom` takes caller-supplied per-share amounts that must sum to `total_amount` (validated by the controller, not the schema). Itemized/by-item splitting (assigning specific order line items to specific guests) is real and common but needs its own, richer UI — deliberately deferred, not assumed here.

**Bill lifecycle:**
- `pay_now` — guest requests a bill immediately; status goes `open` → `awaiting_payment` (a `payment_transactions` row created, keyed to `bill_id`) → `paid` on the webhook, same mechanism as today just moved one level up.
- `pay_after` — a bill can be viewed (running total) before it's finalized; requesting payment moves it through the same `awaiting_payment` → `paid` states, just later in the visit.
- `pay_traditional` — no `payment_transactions` row at all. Status goes `open` → `awaiting_payment` the moment the guest chooses this (which is also what fires the waiter call, below) → `settled_traditionally`, set by a staff member (`process_payment` permission) once they've collected payment in person — a manual, staff-confirmed transition, matching the existing pattern of staff-only state transitions elsewhere (order status, kitchen item status).
- **Split enforcement (controller-level rule, not just documentation):** requesting a split (`POST .../request-split`) moves `bills.status` to `split_requested`. From that point, the whole-bill single-payment endpoint (`POST /v1/bills/:billId/payments/initialize`) must reject with `409` — all payment has to go through the per-share endpoint instead. Until a split is requested, the whole-bill endpoint is always the available default, matching "one bill per table by default, split only on explicit request."

### 26. `staff_calls` (new — IMPLEMENTED 2026-09-21, migration 013)
Durable record of a guest asking for staff — not just a fire-and-forget socket event, for the same audit-trail reason `guest_sessions` isn't a bare JWT. Scoped to payment for this design pass (`reason` is deliberately an enum, not a free-text button, so it stays a small, extensible set rather than open-ended "chat with staff").

```sql
CREATE TABLE staff_calls (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  table_id UUID NOT NULL REFERENCES tables(id) ON DELETE CASCADE,
  sitting_id UUID NOT NULL REFERENCES table_sittings(id) ON DELETE CASCADE,
  bill_id UUID REFERENCES bills(id) ON DELETE SET NULL,  -- set when the call is "come collect payment for this bill"

  reason VARCHAR(20) NOT NULL DEFAULT 'payment',
  status VARCHAR(20) NOT NULL DEFAULT 'pending',

  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  acknowledged_at TIMESTAMP,
  acknowledged_by UUID REFERENCES restaurant_staff(id) ON DELETE SET NULL,
  resolved_at TIMESTAMP,

  CONSTRAINT chk_staff_call_reason CHECK (reason IN ('payment')),
  CONSTRAINT chk_staff_call_status CHECK (status IN ('pending', 'acknowledged', 'resolved'))
);

CREATE INDEX idx_staff_calls_restaurant ON staff_calls(restaurant_id, status);
CREATE INDEX idx_staff_calls_table ON staff_calls(table_id);
```

**Realtime:** a new Socket.io event, `waiter_called`, broadcast to a new `staff:{restaurantId}` room (staff join it the same way they join `kitchen:{restaurantId}` today — see `backend/src/realtime.js` — but this room is for front-of-house staff generally, not kitchen specifically). Payload includes `table_id`/`table_number` and the `bill_id` so staff know exactly which check to bring. `PATCH /v1/restaurants/:restaurantId/staff-calls/:callId` (`process_payment` permission) moves it `pending` → `acknowledged` → `resolved`, and is also the trigger for moving the linked bill to `settled_traditionally` once payment is actually collected.

### 27. `guest_visits` (new — IMPLEMENTED 2026-09-21, migration 013) — the Phase 1 guest-history slot-in
Explicit user decision 2026-09-21: guest history was originally scoped to Phase 2, but VIP tiers, points, and churn detection (Phase 2 features, per the Guest History & Analytics spec) all depend on visits being attributable to a guest from day one — data Phase 1 would otherwise generate and lose. This is deliberately the *minimal* capture layer, not the full Phase 2 analytics (no churn scoring, no VIP tier progression, no cross-restaurant timeline) — those stay Phase 2, built on top of this.

**Reuses the existing `guest_profiles` (table 10)** as the identity anchor — phone-number-keyed, created on a guest's first order, already in this schema since 2026-09-17 — rather than adding a new `guests` table, which a second draft of this design proposed without knowing `guest_profiles` already existed. That also means the already-existing, already-nullable `orders.guest_profile_id` *is* the "attribute every order to a guest" column a second draft proposed adding as `orders.guest_id` — it's already there, nothing new needed on `orders` for this part.

```sql
CREATE TABLE guest_visits (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  guest_profile_id UUID REFERENCES guest_profiles(id) ON DELETE SET NULL,  -- NULL if the guest never placed an order this visit
  restaurant_id UUID NOT NULL REFERENCES restaurants(id) ON DELETE CASCADE,
  sitting_id UUID NOT NULL UNIQUE REFERENCES table_sittings(id) ON DELETE CASCADE,
  bill_id UUID REFERENCES bills(id) ON DELETE SET NULL,

  total_spent DECIMAL(10, 2),  -- filled from bills.total_amount once the sitting's bill settles
  visited_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_guest_visits_profile ON guest_visits(guest_profile_id);
CREATE INDEX idx_guest_visits_restaurant ON guest_visits(restaurant_id);
```

**Important scope caveat, not previously written down:** this inherits `guest_profiles`' existing scope — **per restaurant**, not cross-restaurant. A guest's phone number gets a *different* `guest_profiles` row at each restaurant they visit, so `guest_visits` naturally gives "has this guest been to *this* restaurant before," not "has this guest been to any SnapOrder restaurant before." True cross-restaurant guest identity (in SnapOrder's longer-term spec) needs a platform-level identity layer above `guest_profiles` — a separate, later architectural decision, not something this migration assumes or forecloses. Repeat-visit detection per restaurant, though, is now trivial once this table is populated: `COUNT(*) FROM guest_visits WHERE guest_profile_id = X`.

**Not designed yet, flagged rather than guessed:** itemized/by-item splitting (noted above); what happens to an `open` `pay_after` bill if a guest's session expires/is revoked before they pay (leaves without paying — likely needs a staff-visible "unpaid, guest gone" state, but that's a policy decision, not a schema one); whether `pay_traditional` should still let the guest see a running itemized total in-app before staff arrives; when/how `guest_visits` actually gets written (on sitting close, presumably — route logic, not decided in this schema pass); the cross-restaurant identity layer noted above.

---

## Relationships Summary

```
users ──── restaurant_staff (1:M)  (a user can be staff at more than one restaurant)
users ──── platform_admins (1:1, optional)

restaurants
  ├─ restaurant_staff (1:M)
  │  ├─ shifts (1:M)
  │  └─ table_assignments (1:M) ──── tables
  ├─ tables (1:M)
  │  └─ guest_sessions (1:M)
  ├─ menus (1:M)
  │  └─ meal_categories (1:M)
  │     └─ meals (1:M)
  │        ├─ meal_ingredients (1:M) ──── ingredients
  │        ├─ meal_addons (1:M)
  │        └─ guest_reviews (1:M)
  │           └─ restaurant_responses (1:M)
  ├─ guest_profiles (1:M)
  │  └─ orders (1:M)
  │     ├─ order_items (1:M) ──── meals
  │     └─ guest_reviews (1:M)
  └─ audit_log (1:M)

feature_suggestions ──── suggestions_votes (1:M)
```

---

## Indexes Summary

**High-traffic queries:**
- `idx_orders_status` — Kitchen display (what's cooking?)
- `idx_meals_available` — Menu display (what's available?)
- `idx_tables_qr_code` — QR scan lookup (instant)
- `idx_guest_profiles_phone` — Guest lookup
- `idx_order_items_order` — Order detail fetch
- `idx_users_email` — Login lookup
- `idx_shifts_restaurant_active` — Who's clocked in right now (kitchen queue ABAC scoping)

**Reporting queries:**
- `idx_orders_date` — Daily revenue reports
- `idx_audit_restaurant` — Security audit
- `idx_suggestions_upvotes` — Feature popularity

---

## Data Integrity Constraints

```sql
-- Restaurant cannot be deleted if it has active orders
ALTER TABLE restaurants ADD CONSTRAINT check_no_active_orders 
BEFORE DELETE DO ... (application-level trigger recommended)

-- Order total must match items sum
-- (enforced in application layer, not DB)

-- Payment date cannot be before placed_at
-- (enforced in application layer)
```

---

## Scalability Notes

### Now (100 restaurants, 5,000 orders/day)
- Single PostgreSQL instance
- Connection pooling (Redis)
- Indexes on high-traffic columns

### Later (1,000 restaurants, 50,000 orders/day)
- Partition `orders` table by `restaurant_id` or `placed_at`
- Replicate for read-heavy dashboards
- Archive old orders to cold storage (S3)

### Performance Targets
- Order insertion: < 100ms
- Menu load: < 200ms
- Order status update: < 50ms
- Analytics query: < 2 seconds

---

**Schema Version:** 1.8 — migration 009 added `restaurant_staff.display_name` (customizable guest-facing name) and `table_assignments` (which staff member is serving a table, with history) — both from an explicit user request
**Last Updated:** Sept 17, 2025
**Status:** Implemented — see `backend/database/migrations/001_initial_schema.sql` and `backend/database/migrate.js`
**Database:** PostgreSQL 13+ (running: postgres:15-alpine via docker-compose.yml, host port 5433)
