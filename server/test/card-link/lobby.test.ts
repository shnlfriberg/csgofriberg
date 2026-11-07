import { describe, expect, it } from 'vitest';
import { createMatchSchema } from '../../src/card-link/validation';
import { replaysQuery } from '../../src/card-link/stats';
describe('card lobby validation', () => {
  it('creates daily and friend matches only, rejecting untimed competitive games and invalid limits', () => {
    const base = { variant: 'limited', requestId: 'request-123' };
    // 单人 (practice) starts through /api/game.
    expect(createMatchSchema.safeParse({ ...base, scene: 'practice', duration: 0 }).success).toBe(false);
    expect(createMatchSchema.safeParse({ ...base, scene: 'daily', duration: 0 }).success).toBe(true);
    expect(createMatchSchema.safeParse({ ...base, scene: 'friend', duration: 0 }).success).toBe(false);
    for (const duration of [-1, 1, 121, null]) expect(createMatchSchema.safeParse({ ...base, scene: 'friend', duration }).success).toBe(false);
    expect(replaysQuery.safeParse({ page: '-1' }).success).toBe(false);
    expect(replaysQuery.safeParse({ page: '1.5' }).success).toBe(false);
  });
});
