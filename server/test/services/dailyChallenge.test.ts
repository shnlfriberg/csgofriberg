import { beforeAll, describe, expect, it } from 'vitest';
import { initDb } from '../../src/db/init';
import { initRedis } from '../../src/redis';
import { initPlayerCache } from '../../src/services/playerCache';
import {
  DAILY_CHALLENGE_DIFFICULTIES,
  dailyChallengeMode,
  dailyChallengeWindow,
  ensureDailyChallenges,
  parseDailyChallengeMode,
} from '../../src/services/dailyChallenge';

beforeAll(async () => {
  await initDb();
  await initRedis();
  await initPlayerCache();
});

describe('daily challenge service', () => {
  it('changes date at midnight in Asia/Shanghai', () => {
    const beforeMidnight = dailyChallengeWindow(Date.UTC(2026, 7, 10, 15, 59, 59, 999));
    const atMidnight = dailyChallengeWindow(Date.UTC(2026, 7, 10, 16, 0, 0, 0));

    expect(beforeMidnight).toMatchObject({
      date: '2026-08-10',
      nextRefreshAt: Date.UTC(2026, 7, 10, 16, 0, 0, 0),
    });
    expect(atMidnight).toMatchObject({
      date: '2026-08-11',
      startsAt: Date.UTC(2026, 7, 10, 16, 0, 0, 0),
      nextRefreshAt: Date.UTC(2026, 7, 11, 16, 0, 0, 0),
    });
  });

  it('keeps one stable assignment per difficulty for the current day', async () => {
    const first = await ensureDailyChallenges();
    const second = await ensureDailyChallenges();

    expect(first.challenges.map((item) => item.difficulty)).toEqual(DAILY_CHALLENGE_DIFFICULTIES);
    expect(second).toEqual(first);
    expect(new Set(first.challenges.map((item) => item.targetPlayerId)).size).toBe(
      DAILY_CHALLENGE_DIFFICULTIES.length
    );
  });

  it('encodes and parses daily game modes without ambiguity', () => {
    const mode = dailyChallengeMode('2026-08-11', 'beginner');
    expect(mode).toBe('daily:2026-08-11:beginner');
    expect(parseDailyChallengeMode(mode)).toEqual({ date: '2026-08-11', difficulty: 'beginner' });
    expect(parseDailyChallengeMode('easy')).toBeNull();
  });
});
