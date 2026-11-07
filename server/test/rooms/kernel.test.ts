import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { initRedis, closeRedis, redis, redisKey } from '../../src/redis';
import { ScheduleSource } from '../../src/rooms/kernel/schedules';
import {
  claimOccupancy,
  decodeOccupancy,
  encodeOccupancy,
  lookupOccupancy,
  releaseOccupancy,
  resolveOccupancy,
} from '../../src/rooms/kernel/occupancy';
import { registerRoomAdapter } from '../../src/rooms/kernel/registry';
import { attachPresence, detachPresence, identityScope, onlineIdentities, reapDeadInstances, watchScope } from '../../src/rooms/kernel/presence';
import { registerKernelEvent } from '../../src/rooms/kernel/events';
import { allocateRoomCode, registerCodeNamespace } from '../../src/rooms/kernel/codes';
import { randomUUID } from 'crypto';

const run = randomUUID().slice(0, 8);
const id = (name: string) => `${name}-${run}`;

beforeAll(async () => {
  if (!process.env.REDIS_PREFIX?.startsWith('integration-tests:')) throw new Error('ISOLATED_REDIS_REQUIRED');
  await initRedis();
});
afterAll(async () => {
  await closeRedis();
});

describe('room kernel schedules', () => {
  it('leases due items so only one claimer processes them, and claims single items exactly once', async () => {
    const source = new ScheduleSource('test', `kernel:schedules:test-${run}`);
    const now = Date.now();
    await source.add('tick|A|0', now - 10);
    await source.add('tick|B|0', now + 60_000);
    expect(await source.claimDue(10, now)).toEqual(['tick|A|0']);
    // Leased: a second worker does not see it again.
    expect(await source.claimDue(10, now)).toEqual([]);
    expect(await source.score('tick|A|0')).toBeGreaterThan(now + 10_000);
    // A local timer may claim a due item once; a later deadline is not claimable.
    await source.add('tick|C|0', now);
    expect(await source.claimOne('tick|C|0', now)).toBe(true);
    expect(await source.claimOne('tick|C|0', now)).toBe(false);
    expect(await source.claimOne('tick|B|0', now)).toBe(false);
    await redis()!.del(redisKey(`kernel:schedules:test-${run}`));
  });
});

describe('room kernel site-wide occupancy', () => {
  it('encodes classic seats as bare room ids and other games with a prefix', () => {
    expect(encodeOccupancy({ game: 'classic', roomId: 'ABCDE' })).toBe('ABCDE');
    expect(encodeOccupancy({ game: 'location', roomId: 'ABCDE' })).toBe('location|ABCDE');
    expect(decodeOccupancy('card-link|0f0f')).toEqual({ game: 'card-link', roomId: '0f0f' });
    expect(decodeOccupancy('ABCDE')).toEqual({ game: 'classic', roomId: 'ABCDE' });
    expect(decodeOccupancy('unknown|x')).toBeNull();
  });

  it('claims atomically for a pair, rejects a second game, and releases only its own value', async () => {
    const [a, b] = [id('g:a'), id('g:b')];
    expect(await claimOccupancy({ game: 'location', roomId: 'LOC01' }, [a, b])).toEqual({ ok: true });
    const conflict = await claimOccupancy({ game: 'card-link', roomId: 'match-1' }, [id('g:c'), b]);
    expect(conflict).toMatchObject({ ok: false, identity: b, conflict: { game: 'location', roomId: 'LOC01' } });
    // All-or-nothing: the free identity was not claimed either.
    expect(await lookupOccupancy(id('g:c'))).toBeNull();
    await releaseOccupancy({ game: 'card-link', roomId: 'match-1' }, [a]);
    expect(await lookupOccupancy(a)).toEqual({ game: 'location', roomId: 'LOC01' });
    await releaseOccupancy({ game: 'location', roomId: 'LOC01' }, [a, b]);
    expect(await lookupOccupancy(a)).toBeNull();
  });

  it('reads classic hot state: active members block, eliminated players and finished rooms do not', async () => {
    const client = redis()!;
    const [player, out, watcher] = [id('u:1'), id('u:2'), id('u:3')];
    const room = `K${run.slice(0, 4).toUpperCase()}`;
    await client.hSet(redisKey(`room:${room}:meta`), { status: 'playing' });
    await client.hSet(redisKey(`room:${room}:players`), { [player]: JSON.stringify({ eliminated: false }), [out]: JSON.stringify({ eliminated: true }) });
    await client.hSet(redisKey(`room:${room}:spectators`), watcher, '{}');
    for (const key of [player, out, watcher]) await client.set(redisKey(`identity-room:${key}`), room, { EX: 60 });
    try {
      expect(await claimOccupancy({ game: 'location', roomId: 'LOC02' }, [player])).toMatchObject({ ok: false, conflict: { game: 'classic', roomId: room } });
      expect(await claimOccupancy({ game: 'location', roomId: 'LOC02' }, [watcher])).toMatchObject({ ok: false });
      expect(await claimOccupancy({ game: 'location', roomId: 'LOC02' }, [out])).toEqual({ ok: true });
      await client.hSet(redisKey(`room:${room}:meta`), { status: 'finished' });
      expect(await claimOccupancy({ game: 'location', roomId: 'LOC02' }, [player])).toEqual({ ok: true });
    } finally {
      await client.del([`room:${room}:meta`, `room:${room}:players`, `room:${room}:spectators`].map(redisKey));
      await releaseOccupancy({ game: 'location', roomId: 'LOC02' }, [player, out, watcher]);
      for (const key of [player, out, watcher]) await client.del(redisKey(`identity-room:${key}`));
    }
  });

  it('self-heals stale seats through the owning game, but never a fresh in-flight claim', async () => {
    const key = id('g:stale');
    let active: 'player' | false = false;
    const unregister = registerRoomAdapter({ game: 'card-link', presence: 'watch', isActiveMember: async () => active });
    try {
      await claimOccupancy({ game: 'card-link', roomId: 'old-match' }, [key]);
      // Younger than the in-flight window: kept even though the game says inactive.
      expect(await resolveOccupancy(key)).toMatchObject({ game: 'card-link', roomId: 'old-match' });
      await redis()!.expire(redisKey(`identity-room:${key}`), 60);
      expect(await resolveOccupancy(key)).toBeNull();
      expect(await lookupOccupancy(key)).toBeNull();
      active = 'player';
      await claimOccupancy({ game: 'card-link', roomId: 'live-match' }, [key]);
      await redis()!.expire(redisKey(`identity-room:${key}`), 60);
      expect(await resolveOccupancy(key)).toMatchObject({ game: 'card-link', roomId: 'live-match', role: 'player' });
      // A caller that proved the same-game reference stale may replace it.
      expect(await claimOccupancy({ game: 'card-link', roomId: 'next-match' }, [key], { staleSameGame: true })).toEqual({ ok: true });
    } finally {
      unregister();
      await redis()!.del(redisKey(`identity-room:${key}`));
    }
  });

  it('allocates room codes that are free in every registered namespace', async () => {
    const taken = new Set<string>();
    const unregister = registerCodeNamespace(`test-${run}`, { redisKeys: (code) => [redisKey(`test-code:${run}:${code}`)], localExists: async (code) => taken.has(code) });
    try {
      const code = await allocateRoomCode('test');
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/);
      expect(await redis()!.get(redisKey(`kernel:code:${code}`))).toBe('test');
    } finally { unregister(); }
  });
});

describe('room kernel presence without fetchSockets', () => {
  it('reports online only for the first socket and offline only for the last one', async () => {
    const identity = id('g:tabs');
    const scope = identityScope(identity);
    // Keep this process alive for the liveness check.
    const { instanceId } = await import('../../src/rooms/kernel/instance');
    await redis()!.set(redisKey(`kernel:instance:${instanceId}`), '1', { PX: 15_000 });
    expect(await attachPresence(`s1-${run}`, identity, scope)).toBe(true);
    expect(await attachPresence(`s2-${run}`, identity, scope)).toBe(false);
    expect((await onlineIdentities([scope]))[0].has(identity)).toBe(true);
    expect(await detachPresence(`s1-${run}`, scope)).toBeNull();
    expect(await detachPresence(`s2-${run}`, scope)).toEqual({ scope, identity, online: false });
    expect((await onlineIdentities([scope]))[0].size).toBe(0);
  });

  it('ignores sockets of a crashed instance and reaps them into offline transitions', async () => {
    const client = redis()!;
    const identity = id('g:crash');
    const scope = watchScope('card-link', id('match'));
    const dead = `dead-${run}`;
    await client.hSet(redisKey(`kernel:presence:${scope}`), `sock-${run}`, `${identity}\n${dead}`);
    await client.sAdd(redisKey(`kernel:instance-scopes:${dead}`), `${scope}\nsock-${run}`);
    await client.zAdd(redisKey('kernel:instances'), { score: Date.now() - 60_000, value: dead });
    expect((await onlineIdentities([scope]))[0].size).toBe(0);
    const transitions = await reapDeadInstances();
    expect(transitions).toContainEqual({ scope, identity, online: false });
    expect(await client.hLen(redisKey(`kernel:presence:${scope}`))).toBe(0);
    expect(await client.zScore(redisKey('kernel:instances'), dead)).toBeNull();
  });
});

describe('room kernel event wrapper', () => {
  function fakeSocket() {
    const handlers = new Map<string, (...args: any[]) => void>();
    return { data: {} as Record<string, unknown>, on: (event: string, fn: (...args: any[]) => void) => handlers.set(event, fn), handlers };
  }

  it('keeps each game contract: classic validates before counting, envelopes wrap results and errors', async () => {
    const { z } = await import('zod');
    const socket = fakeSocket();
    const handler = vi.fn(async () => 'done');
    registerKernelEvent(socket as any, {
      event: 'room:test', schema: z.object({ n: z.number() }), ack: 'classic', order: 'validate-then-pending', pendingField: 'pendingEvents',
      handler: async (_payload, ack) => { ack?.({ ok: true }); }, mapError: () => ({ code: 'INTERNAL_ERROR' }),
    });
    registerKernelEvent(socket as any, {
      event: 'location:test', schema: z.object({ n: z.number() }), ack: 'envelope', order: 'pending-then-validate', pendingField: 'pendingLocationEvents',
      handler, mapError: (error) => ({ ok: false, code: (error as { code?: string }).code ?? 'INTERNAL_ERROR' }),
    });
    const classicAck = vi.fn();
    socket.handlers.get('room:test')!({ n: 'x' }, classicAck);
    expect(classicAck).toHaveBeenCalledWith({ code: 'VALIDATION_FAILED' });
    expect(socket.data.pendingEvents).toBeUndefined();
    const envelopeAck = vi.fn();
    socket.handlers.get('location:test')!({ n: 1 }, envelopeAck);
    await vi.waitFor(() => expect(envelopeAck).toHaveBeenCalledWith({ ok: true, data: 'done' }));
    const invalidAck = vi.fn();
    socket.handlers.get('location:test')!({ n: 'x' }, invalidAck);
    await vi.waitFor(() => expect(invalidAck).toHaveBeenCalledWith({ ok: false, code: 'VALIDATION_FAILED' }));
    expect(socket.data.pendingLocationEvents).toBe(0);
  });
});
