import { db } from '../db/knex';
import { DIFFICULTY_LEVELS } from '../difficulties';
import { getDifficultyPlayers, pickCachedTarget } from './playerCache';
import { cached, invalidateCached } from './queryCache';
import { withKeyLock } from './keyLock';
import { userNameFromUsername } from './identityDisplay';

const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAILY_CHALLENGE_RETENTION_DAYS = 90;
const DAILY_LEADERBOARD_TTL_SECONDS = 20;

export const DAILY_CHALLENGE_DIFFICULTIES = DIFFICULTY_LEVELS
  .filter((difficulty) => difficulty.isEnabled)
  .map((difficulty) => difficulty.key);

export interface DailyChallengeWindow {
  date: string;
  startsAt: number;
  nextRefreshAt: number;
}

export interface DailyChallengeRecord {
  id: number;
  challengeDate: string;
  difficulty: string;
  targetPlayerId: number;
}

export interface DailyLeaderboardEntry {
  attemptId: number;
  displayId: string;
  guessCount: number;
}

function formatUtcDate(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function addDateDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  return formatUtcDate(new Date(Date.UTC(year, month - 1, day + days)));
}

export function dailyChallengeWindow(now = Date.now()): DailyChallengeWindow {
  const shanghaiNow = new Date(now + SHANGHAI_OFFSET_MS);
  const year = shanghaiNow.getUTCFullYear();
  const month = shanghaiNow.getUTCMonth();
  const day = shanghaiNow.getUTCDate();
  return {
    date: formatUtcDate(shanghaiNow),
    startsAt: Date.UTC(year, month, day) - SHANGHAI_OFFSET_MS,
    nextRefreshAt: Date.UTC(year, month, day + 1) - SHANGHAI_OFFSET_MS,
  };
}

export function dailyChallengeMode(date: string, difficulty: string): string {
  return `daily:${date}:${difficulty}`;
}

export function parseDailyChallengeMode(
  mode: string
): { date: string; difficulty: string } | null {
  const match = /^daily:(\d{4}-\d{2}-\d{2}):([a-z0-9][a-z0-9_-]{0,31})$/.exec(mode);
  return match ? { date: match[1], difficulty: match[2] } : null;
}

export function isDailyChallengeDifficulty(difficulty: string): boolean {
  return DAILY_CHALLENGE_DIFFICULTIES.some((item) => item === difficulty);
}

function normalizeChallenge(row: any): DailyChallengeRecord {
  return {
    id: Number(row.id),
    challengeDate: String(row.challengeDate),
    difficulty: String(row.difficulty),
    targetPlayerId: Number(row.targetPlayerId),
  };
}

async function challengesForDate(date: string): Promise<DailyChallengeRecord[]> {
  const rows = await db('daily_challenges')
    .where({ challenge_date: date })
    .whereIn('difficulty_key', DAILY_CHALLENGE_DIFFICULTIES)
    .select(
      'id',
      'challenge_date as challengeDate',
      'difficulty_key as difficulty',
      'target_player_id as targetPlayerId'
    );
  const byDifficulty = new Map(rows.map((row) => [String(row.difficulty), normalizeChallenge(row)]));
  return DAILY_CHALLENGE_DIFFICULTIES.flatMap((difficulty) => {
    const challenge = byDifficulty.get(difficulty);
    return challenge ? [challenge] : [];
  });
}

function hasCompleteAssignment(records: DailyChallengeRecord[]): boolean {
  return records.length === DAILY_CHALLENGE_DIFFICULTIES.length &&
    DAILY_CHALLENGE_DIFFICULTIES.every((difficulty) =>
      records.some((record) => record.difficulty === difficulty)
    );
}

export async function ensureDailyChallenges(
  now = Date.now()
): Promise<{ window: DailyChallengeWindow; challenges: DailyChallengeRecord[] }> {
  const window = dailyChallengeWindow(now);
  const current = await challengesForDate(window.date);
  if (hasCompleteAssignment(current)) return { window, challenges: current };

  const challenges = await withKeyLock(`daily-challenge-assignment:${window.date}`, async () => {
    const existing = await challengesForDate(window.date);
    const assigned = new Map(existing.map((record) => [record.difficulty, record]));
    const usedPlayerIds = new Set(existing.map((record) => record.targetPlayerId));

    for (const difficulty of DAILY_CHALLENGE_DIFFICULTIES) {
      if (assigned.has(difficulty)) continue;
      if (!getDifficultyPlayers(difficulty).length) throw new Error('DAILY_CHALLENGE_POOL_EMPTY');
      const target = pickCachedTarget(difficulty, usedPlayerIds);
      if (!target) throw new Error('DAILY_CHALLENGE_POOL_EMPTY');
      await db('daily_challenges')
        .insert({
          challenge_date: window.date,
          difficulty_key: difficulty,
          target_player_id: target.id,
        })
        .onConflict(['challenge_date', 'difficulty_key'])
        .ignore();
      usedPlayerIds.add(target.id);
    }

    await db('daily_challenges')
      .where('challenge_date', '<', addDateDays(window.date, -DAILY_CHALLENGE_RETENTION_DAYS))
      .del();

    const completed = await challengesForDate(window.date);
    if (!hasCompleteAssignment(completed)) throw new Error('DAILY_CHALLENGE_ASSIGNMENT_INCOMPLETE');
    return completed;
  });

  return { window, challenges };
}

export function dailyLeaderboardCacheKey(date: string, difficulty: string): string {
  return `daily-challenge:leaderboard:${date}:${difficulty}`;
}

export function currentDailyLeaderboardCacheKeys(now = Date.now()): string[] {
  const { date } = dailyChallengeWindow(now);
  return DAILY_CHALLENGE_DIFFICULTIES.map((difficulty) =>
    dailyLeaderboardCacheKey(date, difficulty)
  );
}

export async function getDailyLeaderboard(
  challenge: DailyChallengeRecord
): Promise<DailyLeaderboardEntry[]> {
  return cached(
    dailyLeaderboardCacheKey(challenge.challengeDate, challenge.difficulty),
    DAILY_LEADERBOARD_TTL_SECONDS,
    async () => {
      const rows = await db('daily_challenge_attempts as a')
        .leftJoin('users as u', 'u.id', 'a.user_id')
        .where('a.challenge_id', challenge.id)
        .where('a.status', 'won')
        .where((builder) => builder.whereNull('a.user_id').orWhere('u.leaderboard_hidden', false))
        .orderBy('a.guess_count', 'asc')
        .orderBy('a.finished_at', 'asc')
        .orderBy('a.id', 'asc')
        .limit(10)
        .select(
          'a.id as attemptId',
          'a.display_name as displayId',
          'a.guess_count as guessCount'
        );
      return rows.map((row) => ({
        attemptId: Number(row.attemptId),
        displayId: String(row.displayId),
        guessCount: Number(row.guessCount),
      }));
    }
  );
}

export async function claimDailyChallengeAttempts(input: {
  guestKey: string;
  userId: number;
  username: string;
}): Promise<number> {
  const guestIdentity = `g:${input.guestKey}`;
  const userIdentity = `u:${input.userId}`;
  const affectedCacheKeys = new Set<string>();
  const claimed = await db.transaction(async (trx) => {
    const guestRows = await trx('daily_challenge_attempts as a')
      .join('daily_challenges as c', 'c.id', 'a.challenge_id')
      .where('a.identity_key', guestIdentity)
      .select(
        'a.id',
        'a.challenge_id as challengeId',
        'c.challenge_date as challengeDate',
        'c.difficulty_key as difficulty'
      );
    if (!guestRows.length) return 0;

    const challengeIds = guestRows.map((row) => Number(row.challengeId));
    const existingUserRows = await trx('daily_challenge_attempts')
      .where('identity_key', userIdentity)
      .whereIn('challenge_id', challengeIds)
      .select('challenge_id');
    const existingChallenges = new Set(existingUserRows.map((row) => Number(row.challenge_id)));
    let migrated = 0;

    for (const row of guestRows) {
      affectedCacheKeys.add(dailyLeaderboardCacheKey(
        String(row.challengeDate),
        String(row.difficulty)
      ));
      if (existingChallenges.has(Number(row.challengeId))) {
        await trx('daily_challenge_attempts').where({ id: Number(row.id) }).del();
        continue;
      }
      await trx('daily_challenge_attempts')
        .where({ id: Number(row.id) })
        .update({
          identity_key: userIdentity,
          user_id: input.userId,
          guest_key: null,
          display_name: userNameFromUsername(input.username),
        });
      migrated += 1;
    }
    return migrated;
  });

  if (affectedCacheKeys.size) await invalidateCached(...affectedCacheKeys);
  return claimed;
}
