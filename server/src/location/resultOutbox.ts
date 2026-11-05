import { db } from '../db/knex';
import { HttpError } from '../middleware/common';
import { redis, redisKey } from '../redis';
import { withKeyLock } from './lock';
import { readState, writeState, deleteState } from './store';
import { recordResult } from './games';
import { roomView } from './roomView';
import { publicPlayerKey } from './publicIdentity';
import { countMetric } from './metrics';
import type { RoomState } from './types';

export async function queueResult(room: RoomState): Promise<void> {
  await writeState(`outbox:${room.gameId}`, room, 7 * 86400);
  const client = redis();
  if (client)
    await client.zAdd(redisKey('location:outbox'), {
      value: room.gameId,
      score: Date.now(),
    });
}
export async function flushResult(id: string): Promise<void> {
  await withKeyLock(`location:outbox:${id}`, async () => {
    const durable = await db('location_result_outbox').where({ game_id: id }).first();
    if (durable && Number(durable.attempts) >= 10) {
      const client = redis();
      if (client) await client.zRem(redisKey('location:outbox'), id);
      return; // Retained in SQL for administrator inspection and explicit retry.
    }
    if (durable && Number(durable.due_at) > Date.now()) {
      const client = redis();
      if (client) await client.zAdd(redisKey('location:outbox'), { value: id, score: Number(durable.due_at) });
      return;
    }
    try {
      const room = durable ? JSON.parse(durable.payload) as RoomState : await readState<RoomState>(`outbox:${id}`);
      if (!room) {
        const client = redis();
        if (client) await client.zRem(redisKey('location:outbox'), id);
        countMetric('outbox.missing');
        return;
      }
      if (!durable) await db('location_result_outbox').insert({ game_id: id, payload: JSON.stringify(room), attempts: 0, due_at: Date.now() }).onConflict('game_id').ignore();
      const common = roomView(room, room.players[0].identity.key);
      for (const p of room.players) {
        const view = common;
        const key = publicPlayerKey(room.gameId, p.identity.key);
        await recordResult(
          room.gameId,
          p.identity,
          'multiplayer',
          room.difficulty,
          null,
          view.results.find((result) => result.key === key)!.rounds,
          undefined,
          {
            rank: view.players.find((item) => item.key === key)!.rank,
            retired: p.retired,
            myKey: key,
            roomId: room.id,
            participants: view.players,
            roomResults: view.results,
          }
        );
      }
      const client = redis();
      if (client) await client.zRem(redisKey('location:outbox'), id);
      await deleteState(`outbox:${id}`);
      await db('location_result_outbox').where({ game_id: id }).delete();
      countMetric('outbox.completed');
    } catch (error) {
      const dueAt = Date.now() + Math.min(300000, 5000 * 2 ** Math.min(Number(durable?.attempts ?? 0), 6));
      await db('location_result_outbox').where({ game_id: id }).update({
        attempts: db.raw('attempts + 1'), due_at: dueAt,
        last_error: error instanceof Error ? error.message.slice(0, 500) : 'UNKNOWN',
      });
      const client = redis();
      if (client) await client.zAdd(redisKey('location:outbox'), { value: id, score: dueAt });
      countMetric('outbox.retries');
      throw error;
    }
  });
}

export async function retryResult(id: string): Promise<void> {
  await withKeyLock(`location:outbox:${id}`, async () => {
    const dueAt = Date.now();
    const count = await db('location_result_outbox').where({ game_id: id }).update({ attempts: 0, due_at: dueAt, last_error: null });
    if (!count) throw new HttpError(404, 'LOCATION_GAME_NOT_FOUND');
    const client = redis();
    if (client) await client.zAdd(redisKey('location:outbox'), { value: id, score: dueAt });
  });
}
export async function flushDueResults(): Promise<void> {
  const client = redis();
  const cached = client ? await client.zRangeByScore(redisKey('location:outbox'), 0, Date.now(), { LIMIT: { offset: 0, count: 50 } }) : [];
  const rows = await db('location_result_outbox').where('attempts', '<', 10).where('due_at', '<=', Date.now()).orderBy('due_at').limit(50).select('game_id');
  const pending = [...new Set([...rows.map(row => String(row.game_id)), ...cached])];
  for (let i = 0; i < pending.length; i += 2) await Promise.all(pending.slice(i, i + 2).map(async id => {
    try { await flushResult(id); }
    catch (error) {
      if (!(error instanceof Error && error.message === 'RESOURCE_BUSY')) console.error('[location:result-retry]', error);
    }
  }));
}
