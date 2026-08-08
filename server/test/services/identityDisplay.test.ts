import { describe, expect, it } from 'vitest';
import {
  containsForbiddenDisplayToken,
  displayCodeFromSeed,
  guestNameFromKey,
  userNameFromUsername,
} from '../../src/services/identityDisplay';

describe('identity display IDs', () => {
  it('detects numeric, alphabetic and mixed forbidden fragments', () => {
    expect(containsForbiddenDisplayToken('A12B', ['12'])).toBe(true);
    expect(containsForbiddenDisplayToken('ABCD1', ['abcd'])).toBe(true);
    expect(containsForbiddenDisplayToken('9A18X', ['A18'])).toBe(true);
    expect(containsForbiddenDisplayToken('ABCDE', ['12', '34'])).toBe(false);
  });

  it('deterministically remaps only candidates that contain a forbidden fragment', () => {
    const originalCode = displayCodeFromSeed('user', 'alice', []);
    const unchanged = displayCodeFromSeed('user', 'alice', ['12', '34']);
    const remapped = displayCodeFromSeed('user', 'alice', [originalCode]);

    if (!containsForbiddenDisplayToken(originalCode, ['12', '34'])) {
      expect(unchanged).toBe(originalCode);
    }
    expect(remapped).not.toBe(originalCode);
    expect(remapped).toBe(displayCodeFromSeed('user', 'alice', [originalCode]));
    expect(containsForbiddenDisplayToken(remapped, [originalCode])).toBe(false);
  });

  it('keeps user and guest IDs stable without database state', () => {
    expect(userNameFromUsername('stable-user')).toBe(userNameFromUsername('stable-user'));
    expect(guestNameFromKey('stable-guest')).toBe(guestNameFromKey('stable-guest'));
    expect(userNameFromUsername('stable-user')).toMatch(/^用户#[0-9A-Z]{5}$/);
    expect(guestNameFromKey('stable-guest')).toMatch(/^访客#[0-9A-Z]{5}$/);
  });
});
