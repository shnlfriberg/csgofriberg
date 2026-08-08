import { describe, expect, it } from 'vitest';
import { isValidResourceVersion, parseResourceVersionNotice } from '../../src/services/resourceVersion';

describe('resource version notices', () => {
  it('accepts millisecond build timestamps', () => {
    expect(isValidResourceVersion('1753000000000')).toBe(true);
    expect(isValidResourceVersion('1753000000')).toBe(false);
    expect(isValidResourceVersion('a1b2c3d4e5f60')).toBe(false);
  });

  it('rejects malformed persisted notices', () => {
    expect(parseResourceVersionNotice(null)).toBeNull();
    expect(parseResourceVersionNotice('{')).toBeNull();
    expect(parseResourceVersionNotice(JSON.stringify({ version: '1753000000', broadcastAt: 1 }))).toBeNull();
    expect(parseResourceVersionNotice(JSON.stringify({
      version: '1753000000000',
      broadcastAt: 1_753_000_000_000,
    }))).toEqual({ version: '1753000000000', broadcastAt: 1_753_000_000_000 });
  });
});
