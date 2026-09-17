import { roleGrants, ROLES, STAFF_ROLES } from '../../src/authorization/permissions.js';

describe('permissions.roleGrants', () => {
  it('grants owner/manager edit_menu but not waiter/kitchen_staff', () => {
    expect(roleGrants('owner', 'edit_menu')).toBe(true);
    expect(roleGrants('manager', 'edit_menu')).toBe(true);
    expect(roleGrants('waiter', 'edit_menu')).toBe(false);
    expect(roleGrants('kitchen_staff', 'edit_menu')).toBe(false);
  });

  it('grants update_kitchen_item_status to kitchen_staff but not waiter (and modify_order the reverse)', () => {
    expect(roleGrants('kitchen_staff', 'update_kitchen_item_status')).toBe(true);
    expect(roleGrants('waiter', 'update_kitchen_item_status')).toBe(false);
    expect(roleGrants('waiter', 'modify_order')).toBe(true);
    expect(roleGrants('kitchen_staff', 'modify_order')).toBe(false);
  });

  it('grants manage_tables and view_restaurant_analytics to manager/owner/system_admin only', () => {
    for (const role of ['manager', 'owner', 'system_admin']) {
      expect(roleGrants(role, 'manage_tables')).toBe(true);
      expect(roleGrants(role, 'view_restaurant_analytics')).toBe(true);
    }
    for (const role of ['guest', 'waiter', 'kitchen_staff']) {
      expect(roleGrants(role, 'manage_tables')).toBe(false);
    }
  });

  it('never grants override_removal_policy to any role — a hard safety block', () => {
    for (const role of ROLES) {
      expect(roleGrants(role, 'override_removal_policy')).toBe(false);
    }
  });

  it('returns false for an unknown role or unknown permission, not a throw', () => {
    expect(roleGrants('not_a_real_role', 'edit_menu')).toBe(false);
    expect(roleGrants('owner', 'not_a_real_permission')).toBe(false);
  });

  it('STAFF_ROLES matches exactly what restaurant_staff.role\'s CHECK constraint allows', () => {
    expect(STAFF_ROLES).toEqual(['waiter', 'kitchen_staff', 'manager', 'owner']);
  });
});
