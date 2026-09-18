const DEFAULT_TITLE = 'SnapOrder';

// White-label theming (product-vision.md: "every restaurant able to
// customize SnapOrder to their own design/branding... resolved
// per-restaurant at render time") — covers the displayed NAME, not just
// colors: the user's explicit instruction is that a restaurant should be
// able to present its own name to its guests, not the platform's.
// SnapOrder's own Emerald Green (--color-brand in index.css) and the
// "SnapOrder" browser title are the default/reference theme; this
// overrides both with a restaurant's own primary_color/secondary_color/
// name (restaurants table, SNAPORDER_DATABASE_SCHEMA.md table 1) once
// one is known — via inline CSS custom properties + document.title, not
// by editing the stylesheet, so it can change per guest session without
// a rebuild.
export function applyRestaurantTheme(restaurant) {
  const root = document.documentElement;

  if (restaurant?.primary_color) {
    root.style.setProperty('--color-brand', restaurant.primary_color);
  }
  if (restaurant?.secondary_color) {
    root.style.setProperty('--color-brand-hover', restaurant.secondary_color);
  }
  if (restaurant?.name) {
    document.title = restaurant.name;
  }
}

export function resetTheme() {
  const root = document.documentElement;
  root.style.removeProperty('--color-brand');
  root.style.removeProperty('--color-brand-hover');
  document.title = DEFAULT_TITLE;
}
