import { describe, expect, it } from 'vitest';
import {
  containsForbiddenDisplayToken,
  displayCodeFromSeed,
  guestNameFromKey,
  userNameFromUsername,
} from './identityDisplay';

describe('identity display IDs', () => {
  it('detects numeric, alphabetic and mixed forbidden fragments', () => {
    expect(containsForbiddenDisplayToken('A12B', ['12'])).toBe(true);
    expect(containsForbiddenDisplayToken('ABCD1', ['abcd'])).toBe(true);
    expect(containsForbiddenDisplayToken('9A18X', ['A18'])).toBe(true);
    expect(containsForbiddenDisplayToken('ABCDE', ['12', '34'])).toBe(false);
  });

  it('deterministically remaps only candidates that contain a forbidden fragment', () => {
    const legacyCode = displayCodeFromSeed('user', 'alice', []);
    const unchanged = displayCodeFromSeed('user', 'alice', ['12', '34']);
    const remapped = displayCodeFromSeed('user', 'alice', [legacyCode]);

    if (!containsForbiddenDisplayToken(legacyCode, ['12', '34'])) {
      expect(unchanged).toBe(legacyCode);
    }
    expect(remapped).not.toBe(legacyCode);
    expect(remapped).toBe(displayCodeFromSeed('user', 'alice', [legacyCode]));
    expect(containsForbiddenDisplayToken(remapped, [legacyCode])).toBe(false);
  });

  it('keeps user and guest IDs stable without database state', () => {
    expect(userNameFromUsername('stable-user')).toBe(userNameFromUsername('stable-user'));
    expect(guestNameFromKey('stable-guest')).toBe(guestNameFromKey('stable-guest'));
    expect(userNameFromUsername('stable-user')).toMatch(/^用户#[0-9A-Z]{5}$/);
    expect(guestNameFromKey('stable-guest')).toMatch(/^访客#[0-9A-Z]{5}$/);
  });
});
