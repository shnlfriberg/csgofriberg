import { randomUUID } from 'crypto';
import { db } from '../db/knex';
import { duplicateRedisClient, redis, redisKey } from '../redis';
import { invalidateCached } from './queryCache';
import { logTransientError } from './transientLog';
import { leaderboardCacheKey } from './leaderboardCache';
import {
  globalStatsCacheKeysForDifficulty,
  personalStatsCacheKeysForDifficulty,
} from './statsCache';
import { winningGuessMetricsByPlayer } from './matchGuessMetrics';

export interface MatchResultPayload {
  recordId: string;
  dbType: string;
  boType: number;
  winnerKey: string | null;
  reason: string;
  forfeitedKey: string | null;
  participants: {
    key: string;
    userId: number | null;
    name?: string;
    score: number;
  }[];
  reports?: {
    reporterKey: string;
    reportedKey: string;
    description: string;
    createdAt: number;
  }[];
  rounds: Array<{
    round: number;
    targetPlayerId: number;
    winnerKey: string | null;
    reason: string;
    guessesByPlayer: Record<string, number[]>;
    guessTimesByPlayer: Record<string, Array<number | null>>;
  }>;
}

const STREAM_KEY = redisKey('stream:match-results');
const GROUP = 'match-result-writers';
const consumer = `server-${process.pid}-${randomUUID().slice(0, 8)}`;
const DEAD_LETTER_KEY = redisKey('stream:match-results:dead');
let workerClient: NonNullable<ReturnType<typeof duplicateRedisClient>> | null = null;
let pendingClaimCursor = '0-0';

export async function persistMatchResult(payload: MatchResultPayload): Promise<void> {
  const winner = payload.participants.find((player) => player.key === payload.winnerKey);
  const guessMetrics = winningGuessMetricsByPlayer(payload.rounds);
  const participantUserIds = [...new Set(
    payload.participants.flatMap((player) => (player.userId == null ? [] : [player.userId]))
  )];
  const reportValues = (matchId: number | string) => (payload.reports ?? []).map((report) => ({
    match_id: matchId,
    reporter_key: report.reporterKey,
    reported_key: report.reportedKey,
    description: report.description,
    created_at: new Date(report.createdAt),
  }));
  const insertedMatch = await db.transaction(async (trx) => {
    const existingUserIds = new Set<number>();
    if (participantUserIds.length) {
      const users = await trx('users').whereIn('id', participantUserIds).select('id');
      for (const user of users) existingUserIds.add(Number(user.id));
    }
    const persistedUserId = (userId: number | null) => (
      userId != null && existingUserIds.has(userId) ? userId : null
    );
    const participantValues = (player: MatchResultPayload['participants'][number]) => {
      const metrics = guessMetrics.get(player.key);
      return {
        user_id: persistedUserId(player.userId),
        player_key: player.key,
        player_name: player.name ?? '',
        score: player.score,
        is_winner: player.key === payload.winnerKey,
        winning_guess_sum: metrics?.winningGuessSum ?? 0,
        winning_rounds: metrics?.winningRounds ?? 0,
      };
    };
    const inserted = await trx('match_records')
      .insert({
        room_id: payload.recordId,
        db_type: payload.dbType,
        bo_type: payload.boType,
        winner_id: persistedUserId(winner?.userId ?? null),
        winner_key: payload.winnerKey,
        finish_reason: payload.reason,
        forfeited_key: payload.forfeitedKey,
        replay: JSON.stringify(payload.rounds),
      })
      .onConflict('room_id')
      .ignore()
      .returning('id');
    if (!inserted.length) {
      const existing = await trx('match_records')
        .where({ room_id: payload.recordId })
        .first('id');
      if (!existing) return false;
      if (payload.rounds.length) {
        await trx('match_records')
          .where({ id: existing.id })
          .update({ replay: JSON.stringify(payload.rounds) });
        for (const player of payload.participants) {
          const values = participantValues(player);
          await trx('match_players')
            .where({ match_id: existing.id, player_key: player.key })
            .update({
              winning_guess_sum: values.winning_guess_sum,
              winning_rounds: values.winning_rounds,
            });
        }
      }
      const reports = reportValues(existing.id);
      if (reports.length) {
        await trx('match_reports').insert(reports).onConflict(['match_id', 'reporter_key']).ignore();
      }
      return Boolean(payload.rounds.length || reports.length);
    }
    const matchId = typeof inserted[0] === 'object' ? inserted[0].id : inserted[0];
    await trx('match_players').insert(
      payload.participants.map((player) => ({
        match_id: matchId,
        ...participantValues(player),
      }))
    );
    const reports = reportValues(matchId);
    if (reports.length) {
      await trx('match_reports').insert(reports).onConflict(['match_id', 'reporter_key']).ignore();
    }
    return true;
  });
  if (insertedMatch) {
    await invalidateCached(
      leaderboardCacheKey('multi', payload.dbType),
      ...globalStatsCacheKeysForDifficulty(payload.dbType),
      ...payload.participants.flatMap((player) => [
        ...personalStatsCacheKeysForDifficulty(player.key, payload.dbType),
        `room-player-performance:${player.key}`,
      ])
    );
  }
}

export async function enqueueMatchResult(payload: MatchResultPayload): Promise<void> {
  const client = redis();
  if (!client) return persistMatchResult(payload);
  try {
    await client.sendCommand([
      'XADD', STREAM_KEY, 'MAXLEN', '~', '10000', '*', 'payload', JSON.stringify(payload),
    ]);
  } catch (err) {
    // A timed-out XADD may still have reached Redis. Direct persistence is safe
    // because match_records.room_id is a stable UUID and the transaction is idempotent.
    console.warn('[match-result] queue unavailable, persisting directly', err);
    await persistMatchResult(payload);
  }
}

function parseMessages(reply: unknown): { id: string; payload: MatchResultPayload }[] {
  if (!Array.isArray(reply)) return [];
  const messages: { id: string; payload: MatchResultPayload }[] = [];
  for (const stream of reply as any[]) {
    for (const message of stream?.[1] ?? []) {
      const fields = message[1] as string[];
      const payloadIndex = fields.indexOf('payload');
      if (payloadIndex >= 0 && fields[payloadIndex + 1]) {
        messages.push({ id: message[0], payload: JSON.parse(fields[payloadIndex + 1]) });
      }
    }
  }
  return messages;
}

async function handleMessages(client: NonNullable<ReturnType<typeof duplicateRedisClient>>, reply: unknown) {
  for (const message of parseMessages(reply)) {
    try {
      await persistMatchResult(message.payload);
      await client.sendCommand(['XACK', STREAM_KEY, GROUP, message.id]);
    } catch (err) {
      console.error('[match-result] persist failed, pending for retry', err);
      const pending = await client.sendCommand(['XPENDING', STREAM_KEY, GROUP, message.id, message.id, '1']) as any[];
      const deliveryCount = Number(pending?.[0]?.[3] ?? 1);
      if (deliveryCount >= 10) {
        await client.sendCommand([
          'XADD', DEAD_LETTER_KEY, 'MAXLEN', '~', '2000', '*',
          'sourceId', message.id,
          'payload', JSON.stringify(message.payload),
          'error', err instanceof Error ? err.message.slice(0, 500) : String(err).slice(0, 500),
        ]);
        await client.sendCommand(['XACK', STREAM_KEY, GROUP, message.id]);
      }
    }
  }
}

async function claimPending(client: NonNullable<ReturnType<typeof duplicateRedisClient>>) {
  const result = await client.sendCommand([
    'XAUTOCLAIM', STREAM_KEY, GROUP, consumer, '5000', pendingClaimCursor, 'COUNT', '20',
  ]) as any[];
  pendingClaimCursor = typeof result?.[0] === 'string' ? result[0] : '0-0';
  const claimed = result?.[1];
  if (!Array.isArray(claimed) || !claimed.length) return;
  await handleMessages(client, [[STREAM_KEY, claimed]]);
}

export async function initMatchResultWorker(): Promise<() => Promise<void>> {
  const client = duplicateRedisClient('match-result');
  if (!client) return async () => undefined;
  workerClient = client;
  await client.connect();
  try {
    await client.sendCommand(['XGROUP', 'CREATE', STREAM_KEY, GROUP, '0', 'MKSTREAM']);
  } catch (err) {
    if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
  }

  void (async () => {
    while (client.isOpen) {
      try {
        await claimPending(client);
        const reply = await client.sendCommand([
          'XREADGROUP', 'GROUP', GROUP, consumer, 'COUNT', '20', 'BLOCK', '2000',
          'STREAMS', STREAM_KEY, '>',
        ]);
        await handleMessages(client, reply);
      } catch (err) {
        if (client.isOpen) {
          logTransientError('[match-result]', err);
          await new Promise((resolve) => setTimeout(resolve, 1000));
        }
      }
    }
  })().catch((err) => logTransientError('[match-result:stopped]', err));
  return async () => {
    const active = workerClient;
    workerClient = null;
    if (active?.isOpen) await active.disconnect();
  };
}
