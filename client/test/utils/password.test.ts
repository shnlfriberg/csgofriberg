import { describe, expect, it } from 'vitest';
import { validNewPassword } from '../../src/utils/password';

describe('new password byte limit', () => {
  it('keeps ten-character minimum and counts UTF-8 bytes for non-ASCII input', () => {
    expect(validNewPassword('A'.repeat(9))).toBe(false);
    expect(validNewPassword('A'.repeat(72))).toBe(true);
    expect(validNewPassword('A'.repeat(73))).toBe(false);
    expect(validNewPassword('密'.repeat(24))).toBe(true);
    expect(validNewPassword('密'.repeat(24) + 'A')).toBe(false);
  });
});
