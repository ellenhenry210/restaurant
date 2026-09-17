import { generateToken, verifyToken, generateGuestToken } from '../../src/auth.js';

describe('auth: staff tokens', () => {
  it('round-trips a userId through generateToken/verifyToken', () => {
    const token = generateToken('user-123');
    const payload = verifyToken(token);
    expect(payload.sub).toBe('user-123');
  });

  it('a staff token carries only `sub` — no role/restaurant_id (kept minimal on purpose, see auth.js)', () => {
    const payload = verifyToken(generateToken('user-123'));
    expect(Object.keys(payload).sort()).toEqual(['exp', 'iat', 'sub']);
  });

  it('rejects a tampered token', () => {
    const token = generateToken('user-123');
    const tampered = token.slice(0, -2) + (token.slice(-2) === 'aa' ? 'bb' : 'aa');
    expect(() => verifyToken(tampered)).toThrow();
  });

  it('throws for a missing userId', () => {
    expect(() => generateToken(undefined)).toThrow();
    expect(() => generateToken(null)).toThrow();
  });
});

describe('auth: guest tokens', () => {
  it('embeds type/tableId/restaurantId — deliberately non-minimal, unlike staff tokens', () => {
    const token = generateGuestToken('session-1', { tableId: 'table-1', restaurantId: 'rest-1' });
    const payload = verifyToken(token);
    expect(payload).toMatchObject({ sub: 'session-1', type: 'guest', tableId: 'table-1', restaurantId: 'rest-1' });
  });

  it('throws if tableId or restaurantId is missing', () => {
    expect(() => generateGuestToken('session-1', { tableId: 'table-1' })).toThrow();
    expect(() => generateGuestToken('session-1', { restaurantId: 'rest-1' })).toThrow();
  });
});
