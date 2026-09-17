// The permission matrix from SNAPORDER_AUTHORIZATION.md Part 1, as code.
// Each entry mirrors one row of that table exactly — same grouping, same
// role columns, same ✅/➖ pattern — specifically so it can be checked
// against the doc by eye, not just trusted. If you change a permission
// here, update the doc's table too (and vice versa).
//
// Scope: `authorize()` middleware (../middleware/authorize.js) can only
// enforce roles that are actually backed by data today — 'waiter',
// 'kitchen_staff', 'manager', 'owner' (restaurant_staff.role). 'guest'
// and 'system_admin' permissions are listed here for completeness and
// to keep this file a faithful transcription of the doc, but neither
// role has a real identity mechanism yet: guests aren't authenticated
// via users/JWT at all (phone-only, see guest_profiles), and there's no
// platform_admins table yet for system_admin (see Part 6 of the doc).
// A permission whose only ✅ is 'guest' or 'system_admin' currently
// cannot be granted by this middleware to anyone.

export const ROLES = ['guest', 'waiter', 'kitchen_staff', 'manager', 'owner', 'system_admin'];

// Roles actually enforceable today, resolved from restaurant_staff.role.
export const STAFF_ROLES = ['waiter', 'kitchen_staff', 'manager', 'owner'];

const PERMISSIONS = [
  // Menu
  { key: 'view_menu', roles: ['guest', 'waiter', 'kitchen_staff', 'manager', 'owner', 'system_admin'] },
  { key: 'edit_menu', roles: ['manager', 'owner', 'system_admin'] },
  { key: 'publish_menu', roles: ['manager', 'owner', 'system_admin'] },
  { key: 'delete_meal', roles: ['owner', 'system_admin'] },

  // Inventory
  { key: 'view_inventory', roles: ['waiter', 'kitchen_staff', 'manager', 'owner', 'system_admin'] },
  { key: 'mark_out_of_stock', roles: ['kitchen_staff', 'manager', 'owner', 'system_admin'] },
  { key: 'set_inventory_levels', roles: ['manager', 'owner', 'system_admin'] },
  { key: 'set_removal_policy', roles: ['manager', 'owner', 'system_admin'] },

  // Orders
  { key: 'place_order', roles: ['guest'] },
  { key: 'request_ingredient_removal', roles: ['guest'] },
  { key: 'view_own_order', roles: ['guest', 'waiter', 'kitchen_staff', 'manager', 'owner', 'system_admin'] },
  { key: 'view_all_orders', roles: ['waiter', 'kitchen_staff', 'manager', 'owner', 'system_admin'] },
  // Guest can cancel their own order, but only before it enters 'preparing'
  // — that's an ABAC/state condition (Part 2, condition 5), not a role
  // grant, so it's enforced by the route's abac option, not this table.
  { key: 'cancel_order', roles: ['guest', 'waiter', 'manager', 'owner', 'system_admin'] },
  { key: 'modify_order', roles: ['waiter', 'manager', 'owner', 'system_admin'] },

  // Kitchen
  { key: 'view_kitchen_queue', roles: ['kitchen_staff', 'manager', 'owner', 'system_admin'] },
  { key: 'update_kitchen_item_status', roles: ['kitchen_staff', 'manager', 'owner', 'system_admin'] },
  { key: 'flag_kitchen_issue', roles: ['kitchen_staff', 'manager', 'owner', 'system_admin'] },
  // No role grants this — every column in the doc is ➖. A hard block,
  // not just "nobody happens to have it yet": no future role should be
  // added to this list without a deliberate, documented decision to
  // change the allergen-safety model in SNAPORDER_AUTHORIZATION.md Part 3.
  { key: 'override_removal_policy', roles: [] },

  // Payment
  { key: 'pay_own_order', roles: ['guest'] },
  { key: 'process_payment', roles: ['waiter', 'manager', 'owner', 'system_admin'] },
  { key: 'issue_refund', roles: ['manager', 'owner', 'system_admin'] },
  { key: 'view_payment_history', roles: ['manager', 'owner', 'system_admin'] },

  // Analytics
  { key: 'view_restaurant_analytics', roles: ['manager', 'owner', 'system_admin'] },
  { key: 'view_platform_analytics', roles: ['system_admin'] },

  // Staff
  { key: 'view_staff', roles: ['manager', 'owner', 'system_admin'] },
  { key: 'assign_shifts', roles: ['manager', 'owner', 'system_admin'] },
  { key: 'manage_staff', roles: ['owner', 'system_admin'] }, // hire/remove
  { key: 'view_staff_performance', roles: ['manager', 'owner', 'system_admin'] },
  // Not in the original Part 1 matrix — added 2026-09-17 alongside the
  // table_assignments feature (an explicit user request). Same role set
  // as assign_shifts: assigning a table to a server is the same kind of
  // day-to-day scheduling decision as assigning a shift, so it's a
  // Manager-level action, not something a Waiter or Kitchen Staff
  // member grants themselves.
  { key: 'assign_table', roles: ['manager', 'owner', 'system_admin'] },
  // Also not in the original Part 1 matrix — added 2026-09-17 for QR
  // code generation (routes/qr.js). Printing/regenerating a table's QR
  // is a setup action, same tier as assign_table, not something a
  // Waiter or Kitchen Staff member does themselves.
  { key: 'manage_tables', roles: ['manager', 'owner', 'system_admin'] },

  // Feedback
  { key: 'leave_review', roles: ['guest'] },
  { key: 'edit_own_review', roles: ['guest'] },
  { key: 'reply_to_review', roles: ['manager', 'owner', 'system_admin'] },
  // The one row where system_admin is ➖ but every restaurant-scoped role
  // (including guest) is ✅ — transcribed exactly as the doc has it, not
  // an error: platform staff voting on feature suggestions would be a
  // conflict of interest the doc deliberately excludes.
  { key: 'vote_suggestion', roles: ['guest', 'waiter', 'kitchen_staff', 'manager', 'owner'] },
  { key: 'moderate_review', roles: ['owner', 'system_admin'] }, // approve/remove

  // Suggestions
  { key: 'set_roadmap_status', roles: ['system_admin'] },
];

const ROLE_PERMISSIONS = Object.fromEntries(
  ROLES.map((role) => [role, PERMISSIONS.filter((p) => p.roles.includes(role)).map((p) => p.key)])
);

/**
 * Does this role have this permission, by role grant alone? (ABAC
 * conditions, if any apply to the permission, are checked separately —
 * see middleware/authorize.js.)
 */
export function roleGrants(role, permissionKey) {
  return (ROLE_PERMISSIONS[role] ?? []).includes(permissionKey);
}

export { ROLE_PERMISSIONS };
