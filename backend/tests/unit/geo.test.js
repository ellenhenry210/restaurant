import { distanceMeters, isWithinRadius } from '../../src/geo.js';

describe('geo.distanceMeters', () => {
  it('returns ~0 for the same point', () => {
    const point = { latitude: 6.5244, longitude: 3.3792 };
    expect(distanceMeters(point, point)).toBeCloseTo(0, 3);
  });

  it('matches the known London-Paris great-circle distance (~344km)', () => {
    const london = { latitude: 51.5074, longitude: -0.1278 };
    const paris = { latitude: 48.8566, longitude: 2.3522 };
    const km = distanceMeters(london, paris) / 1000;
    expect(km).toBeGreaterThan(340);
    expect(km).toBeLessThan(348);
  });
});

describe('geo.isWithinRadius', () => {
  const restaurant = { latitude: 6.5244, longitude: 3.3792 };

  it('is true for a point at the exact same coordinates', () => {
    expect(isWithinRadius(restaurant, restaurant, 150)).toBe(true);
  });

  it('is false for a point far outside the radius', () => {
    // ~1 degree of latitude is roughly 111km — nowhere near 150m.
    const farAway = { latitude: restaurant.latitude + 1, longitude: restaurant.longitude };
    expect(isWithinRadius(farAway, restaurant, 150)).toBe(false);
  });
});
