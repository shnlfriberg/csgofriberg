import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { io as clientIo, Socket as ClientSocket } from 'socket.io-client';
import { initDb } from '../db/init';
import { db } from '../db/knex';
import { initRedis, redis, redisKey } from '../redis';
import { initPlayerCache } from '../services/playerCache';
import { resolveSocketIp, setRecoveryWindow, setupSocket } from './index';
import { browserFingerprint, POW_COOKIE } from '../services/pow';
import jwt from 'jsonwebtoken';
import { config } from '../config';
import { guestNameFromKey, signToken } from '../middleware/auth';
import { cancelQueue, getRoom, queueOrTakeOpponent, withRoomLock } from '../services/roomStore';

let server: http.Server;
let io: Server;
let baseUrl: string;
let stopSocket: (() => Promise<void>) | undefined;
const createdRoomIds: string[] = [];
const TEST_USER_AGENT = 'csgofriberg-socket-test';

function connect(cookie: string, auth: Record<string, unknown> = {}): Promise<ClientSocket> {
  return new Promise((resolve, reject) => {
    const socket = clientIo(baseUrl, {
      transports: ['websocket'],
      extraHeaders: { Cookie: cookie, 'User-Agent': TEST_USER_AGENT },
      auth,
    });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', (error) => {
      socket.disconnect();
      reject(error);
    });
  });
}

function withPowCookie(cookie: string, expiresIn: string | number = '10m'): string {
  const token = jwt.sign(
    {
      typ: 'pow',
      fp: browserFingerprint(TEST_USER_AGENT),
      jti: `test-${Date.now()}-${Math.random()}`,
      difficulty: 18,
    },
    config.jwtSecret,
    { expiresIn, algorithm: 'HS256' }
  );
  return `${cookie}; ${POW_COOKIE}=${token}`;
}

function emit(socket: ClientSocket, event: string, payload: unknown = {}): Promise<any> {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

function onceEvent(socket: ClientSocket, event: string, timeoutMs = 2_000): Promise<any> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`EVENT_TIMEOUT:${event}`)), timeoutMs);
    socket.once(event, (payload) => {
      clearTimeout(timer);
      resolve(payload);
    });
  });
}

describe('multiplayer socket integration', () => {
  beforeAll(async () => {
    config.disconnectForfeitMs = 300;
    await initDb();
    await initRedis();
    await setRecoveryWindow(0);
    await initPlayerCache();
    server = http.createServer();
    io = new Server(server, { cors: { origin: '*' } });
    stopSocket = setupSocket(io);
    await new Promise<void>((resolve) => server.listen(0, resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  it('cleans expired matchmaking entries and cancels queues without an index key', async () => {
    const stamp = Date.now();
    const staleIdentity = `g:stale-queue-${stamp}`;
    const identity = {
      key: `g:queue-${stamp}`,
      userId: null,
      name: 'queue-test',
      socketId: `queue-socket-${stamp}`,
    };
    const client = redis()!;
    const queueKey = redisKey('matchmaking:easy');
    await client.zAdd(queueKey, { score: Date.now() - 301_000, value: staleIdentity });

    expect(await queueOrTakeOpponent('easy', identity)).toBeNull();
    expect(await client.zScore(queueKey, staleIdentity)).toBeNull();
    expect(await client.zScore(queueKey, identity.key)).not.toBeNull();

    await client.del(redisKey(`match-queue:${identity.key}`));
    await cancelQueue(identity.key);
    expect(await client.zScore(queueKey, identity.key)).toBeNull();
    expect(await client.get(redisKey(`match-profile:${identity.key}`))).toBeNull();
  });

  it('uses only trusted proxy headers for socket IP limits', () => {
    expect(resolveSocketIp(
      '127.0.0.1',
      '198.51.100.10, 203.0.113.20',
      '198.51.100.10',
      true
    )).toBe('203.0.113.20');
    expect(resolveSocketIp(
      '127.0.0.1',
      '198.51.100.10',
      '198.51.100.10',
      false
    )).toBe('127.0.0.1');
    expect(resolveSocketIp(
      '127.0.0.1',
      'not-an-ip',
      '198.51.100.11',
      true
    )).toBe('198.51.100.11');
  });

  it('rejects malformed event payloads before room state changes', async () => {
    const key = `validation-${Date.now()}`;
    const token = jwt.sign({ key, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const socket = await connect(withPowCookie(`csgofriberg_guest=${token}`));
    try {
      expect(await emit(socket, 'room:create', { dbType: 'easy', boType: 2 }))
        .toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(socket, 'room:join', { roomId: '../bad' }))
        .toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(socket, 'room:player-stats', { playerKey: '' }))
        .toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(socket, 'match:rematch-respond', { accept: 'yes' }))
        .toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(socket, 'game:guess', {
        playerId: '1',
        roundId: 1,
        eventId: 'short',
      })).toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(socket, 'game:surrender-round', { roundId: 0 }))
        .toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(socket, 'match:start', { dbType: ['easy'] }))
        .toEqual({ code: 'VALIDATION_FAILED' });
    } finally {
      socket.disconnect();
    }
  });

  it('only exposes room player stats to opponents and room spectators', async () => {
    const stamp = Date.now();
    const keyA = `stats-room-a-${stamp}`;
    const keyB = `stats-room-b-${stamp}`;
    const spectatorKey = `stats-room-spectator-${stamp}`;
    const outsiderKey = `stats-room-outsider-${stamp}`;
    const historyPrefix = `socket-player-stats-${stamp}`;
    const guestToken = (key: string) => jwt.sign(
      { key, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const a = await connect(withPowCookie(`csgofriberg_guest=${guestToken(keyA)}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${guestToken(keyB)}`));
    const spectator = await connect(withPowCookie(`csgofriberg_guest=${guestToken(spectatorKey)}`));
    const outsider = await connect(withPowCookie(`csgofriberg_guest=${guestToken(outsiderKey)}`));
    try {
      const [target] = await db('players').select('id').limit(1);
      await db('games').insert([
        {
          session_id: `${historyPrefix}-single-win`,
          guest_key: keyB,
          target_player_id: target.id,
          mode: 'easy',
          guesses: JSON.stringify([target.id]),
          first_guess_player_id: target.id,
          status: 'won',
          guess_count: 2,
          finished_at: db.fn.now(),
        },
        {
          session_id: `${historyPrefix}-single-loss`,
          guest_key: keyB,
          target_player_id: target.id,
          mode: 'normal',
          guesses: JSON.stringify([target.id]),
          first_guess_player_id: target.id,
          status: 'lost',
          guess_count: 6,
          finished_at: db.fn.now(),
        },
      ]);
      for (const [index, won] of [true, false].entries()) {
        const [inserted] = await db('match_records')
          .insert({
            room_id: `${historyPrefix}-multi-${index}`,
            db_type: 'easy',
            bo_type: 3,
            winner_key: won ? `g:${keyB}` : `g:${keyA}`,
            finish_reason: 'score',
          })
          .returning('id');
        const matchId = typeof inserted === 'object' ? inserted.id : inserted;
        await db('match_players').insert({
          match_id: matchId,
          player_key: `g:${keyB}`,
          player_name: guestNameFromKey(keyB),
          score: won ? 2 : 1,
          is_winner: won,
        });
      }

      const created = await emit(a, 'room:create', {
        dbType: 'easy',
        boType: 3,
        allowSpectators: true,
      });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(spectator, 'room:join', { roomId: created.room.id, spectate: true });

      const opponentStats = await emit(a, 'room:player-stats', { playerKey: `g:${keyB}` });
      expect(opponentStats).toEqual({
        playerKey: `g:${keyB}`,
        displayId: guestNameFromKey(keyB),
        stats: {
          single: {
            games: 2,
            wins: 1,
            losses: 1,
            winRate: 0.5,
            avgGuesses: 2,
            bestGuesses: 2,
          },
          multi: { games: 2, wins: 1, losses: 1, winRate: 0.5 },
        },
      });
      expect(await emit(a, 'room:player-stats', { playerKey: `g:${keyA}` }))
        .toEqual({ code: 'FORBIDDEN' });
      expect(await emit(a, 'room:player-stats', { playerKey: `g:${outsiderKey}` }))
        .toEqual({ code: 'FORBIDDEN' });

      const spectatorA = await emit(spectator, 'room:player-stats', { playerKey: `g:${keyA}` });
      const spectatorB = await emit(spectator, 'room:player-stats', { playerKey: `g:${keyB}` });
      expect(spectatorA.stats.single.games).toBe(0);
      expect(spectatorB.stats.multi.wins).toBe(1);
      expect(await emit(outsider, 'room:player-stats', { playerKey: `g:${keyB}` }))
        .toEqual({ code: 'NOT_IN_ROOM' });
    } finally {
      a.disconnect();
      b.disconnect();
      spectator.disconnect();
      outsider.disconnect();
      await db('games').where('session_id', 'like', `${historyPrefix}%`).del();
      await db('match_records').where('room_id', 'like', `${historyPrefix}%`).del();
    }
  });

  it('waits five seconds after matchmaking before starting the first round', async () => {
    const stamp = Date.now();
    const keyA = `match-delay-a-${stamp}`;
    const keyB = `match-delay-b-${stamp}`;
    const tokenA = jwt.sign({ key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    let replacement: ClientSocket | null = null;
    try {
      expect(await emit(a, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: true });
      const foundA = onceEvent(a, 'match:found');
      const foundB = onceEvent(b, 'match:found');
      const roundA = onceEvent(a, 'round:start', 8_000);
      const roundB = onceEvent(b, 'round:start', 8_000);
      const matchedAt = Date.now();
      expect(await emit(b, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: false });

      const [matchA, matchB] = await Promise.all([foundA, foundB]);
      expect(matchA.startsAt).toBe(matchB.startsAt);
      expect(matchA.startsInMs).toBeGreaterThanOrEqual(4_500);
      expect(matchA.startsInMs).toBeLessThanOrEqual(5_000);
      expect(matchA.startsAt - matchedAt).toBeGreaterThanOrEqual(4_500);
      expect(matchA.startsAt - matchedAt).toBeLessThanOrEqual(5_500);

      const synced = await emit(a, 'room:sync');
      createdRoomIds.push(synced.room.id);
      expect(synced.serverNow).toEqual(expect.any(Number));
      expect(synced.room.matchStartsAt - synced.serverNow).toBeGreaterThanOrEqual(4_000);
      expect(synced.room.matchStartsAt - synced.serverNow).toBeLessThanOrEqual(5_000);
      expect(synced.room).toMatchObject({
        status: 'waiting',
        round: 0,
        matchStartsAt: matchA.startsAt,
      });

      const [startedA, startedB] = await Promise.all([roundA, roundB]);
      expect(Date.now() - matchedAt).toBeGreaterThanOrEqual(4_500);
      expect(startedA.serverNow).toEqual(expect.any(Number));
      expect(startedA.room).toMatchObject({ status: 'playing', round: 1, matchStartsAt: null });
      expect(startedB.room.id).toBe(startedA.room.id);

      await withRoomLock(startedA.room.id, (room) => {
        room.status = 'finished';
        room.rematchAllowed = false;
        room.roundEndsAt = null;
        room.nextRoundAt = null;
        room.matchResult = { winnerKey: null, reason: 'test', forfeitedKey: null };
        return { room };
      });
      a.disconnect();
      replacement = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
      expect((await emit(replacement, 'room:sync')).room.status).toBe('finished');
      expect(await emit(replacement, 'room:leave')).toEqual({ ok: true });
      expect(await emit(replacement, 'room:sync')).toEqual({ code: 'NOT_IN_ROOM' });
    } finally {
      a.disconnect();
      b.disconnect();
      replacement?.disconnect();
    }
  }, 10_000);

  afterAll(async () => {
    const client = redis();
    if (client) {
      for (const roomId of createdRoomIds) {
        const key = redisKey(`room:${roomId}`);
        const raw = await client.get(key);
        if (!raw) continue;
        const room = JSON.parse(raw);
        await client.del([key, ...[...room.players, ...room.spectators]
          .map((member: any) => redisKey(`identity-room:${member.key}`))]);
        await client.zRem(redisKey('rooms:active'), roomId);
        await client.zRem(redisKey(`rooms:active:ip:${room.ownerIp}`), roomId);
      }
    }
    await stopSocket?.();
    if (io) io.close();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('serializes starts and rejects stale or duplicate guesses', async () => {
    const stamp = Date.now();
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../config');
    const guestTokenA = jwt.default.sign({ key: `socket-a-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const guestTokenB = jwt.default.sign({ key: `socket-b-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${guestTokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${guestTokenB}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'normal', boType: 1 });
      createdRoomIds.push(created.room.id);
      expect(created.room.players[0].name).toBe(guestNameFromKey(`socket-a-${stamp}`));
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready');
      const starts = await Promise.all([emit(a, 'game:start'), emit(a, 'game:start')]);
      expect(starts.every((result) => result.ok)).toBe(true);
      const synced = await emit(a, 'room:sync');
      expect(synced.room.roundId).toBe(1);
      const room = await redis()!.get(redisKey(`room:${created.room.id}`));
      const stored = JSON.parse(room!);
      const targetId = stored.targetPlayerId;
      const stale = await emit(a, 'game:guess', {
        playerId: targetId,
        roundId: synced.room.roundId - 1,
        eventId: `stale-${stamp}-0001`,
      });
      expect(stale.code).toBe('STALE_ROUND');
      const eventId = `valid-${stamp}-0001`;
      const results = await Promise.all([
        emit(a, 'game:guess', { playerId: targetId, roundId: synced.room.roundId, eventId }),
        emit(a, 'game:guess', { playerId: targetId, roundId: synced.room.roundId, eventId }),
        emit(b, 'game:guess', { playerId: targetId, roundId: synced.room.roundId, eventId: `valid-${stamp}-0002` }),
      ]);
      expect(results.every((result) => result.feedback === undefined)).toBe(true);
      results.filter((result) => !result.code).forEach((result) => {
        expect(result.cooldownMs).toEqual(expect.any(Number));
      });
      const finalRoom = await getRoom(created.room.id);
      expect(finalRoom).not.toBeNull();
      expect(finalRoom!.players.reduce((sum: number, player: any) => sum + player.score, 0)).toBe(1);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('does not silently downgrade an expected authenticated socket to guest', async () => {
    const token = jwt.sign(
      { key: `auth-intent-${Date.now()}`, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    await expect(connect(
      withPowCookie(`csgofriberg_guest=${token}`),
      { authenticated: true }
    )).rejects.toMatchObject({ message: 'AUTH_EXPIRED' });
  });

  it('restores the last resource version notice when a client connects', async () => {
    const stamp = Date.now();
    const notice = { version: '1753000000000', broadcastAt: stamp };
    const token = jwt.sign({ key: `resource-version-${stamp}`, typ: 'guest' }, config.jwtSecret, {
      expiresIn: '1h',
    });
    await redis()!.set(redisKey('resource:version'), JSON.stringify(notice));
    const socket = clientIo(baseUrl, {
      autoConnect: false,
      transports: ['websocket'],
      extraHeaders: { Cookie: `csgofriberg_guest=${token}`, 'User-Agent': TEST_USER_AGENT },
    });
    try {
      const received = onceEvent(socket, 'resource:version');
      const connected = new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve());
        socket.once('connect_error', reject);
      });
      socket.connect();
      await connected;
      await expect(received).resolves.toEqual(notice);
    } finally {
      socket.disconnect();
      await redis()!.del(redisKey('resource:version'));
    }
  });

  it('starts a rematch in a created room only after invitation, acceptance, and guest readiness', async () => {
    const stamp = Date.now();
    const keyA = `rematch-a-${stamp}`;
    const keyB = `rematch-b-${stamp}`;
    const tokenA = jwt.sign({ key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 1 });
      createdRoomIds.push(created.room.id);
      expect(created.room.rematchAllowed).toBe(true);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      expect((await emit(a, 'game:start')).ok).toBe(true);

      const active = await getRoom(created.room.id);
      const originalRecordId = active!.recordId;
      const matchOverEvent = onceEvent(a, 'match:over');
      await emit(a, 'game:guess', {
        playerId: active!.targetPlayerId,
        roundId: active!.round,
        eventId: `rematch-finish-${stamp}`,
      });
      await matchOverEvent;

      const inviteEvent = onceEvent(b, 'match:rematch:update');
      const inviteAck = await emit(a, 'match:rematch-invite');
      expect(inviteAck).toEqual({ ok: true, stateVersion: expect.any(Number) });
      const invited = await inviteEvent;
      expect(invited).toMatchObject({
        roomId: created.room.id,
        stateVersion: expect.any(Number),
        outcome: 'invited',
        actorKey: `g:${keyA}`,
      });
      expect(invited).not.toHaveProperty('room');
      expect(invited).not.toHaveProperty('players');
      expect(invited).not.toHaveProperty('rematchInvite');
      expect(JSON.stringify(invited).length).toBeLessThan(200);
      expect((await emit(a, 'match:rematch-respond', { accept: true })).code)
        .toBe('REMATCH_RESPONSE_NOT_ALLOWED');

      const acceptedEvent = onceEvent(a, 'match:rematch:update');
      const acceptedAck = await emit(b, 'match:rematch-respond', { accept: true });
      expect(acceptedAck).toEqual({ ok: true, stateVersion: expect.any(Number) });
      const accepted = await acceptedEvent;
      expect(accepted.outcome).toBe('accepted');
      expect(accepted).toMatchObject({
        roomId: created.room.id,
        stateVersion: expect.any(Number),
      });
      expect(accepted).not.toHaveProperty('room');
      expect(accepted).not.toHaveProperty('reset');
      expect(JSON.stringify(accepted).length).toBeLessThan(200);
      const rematchRoom = await getRoom(created.room.id);
      expect(rematchRoom?.recordId).not.toBe(originalRecordId);
      expect(rematchRoom?.players.map((player) => ({ key: player.key, ready: player.ready, score: player.score })))
        .toEqual([
          { key: `g:${keyA}`, ready: true, score: 0 },
          { key: `g:${keyB}`, ready: false, score: 0 },
        ]);
      expect(rematchRoom?.replayRounds).toEqual([]);
      expect((await emit(a, 'game:start')).code).toBe('PLAYERS_NOT_READY');

      expect((await emit(b, 'room:ready', { ready: true })).ok).toBe(true);
      expect((await emit(a, 'game:start')).ok).toBe(true);
      const restarted = await getRoom(created.room.id);
      expect(restarted).toMatchObject({ status: 'playing', round: 1 });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('uses room patches and event-only guess feedback', async () => {
    const stamp = Date.now();
    const tokenA = jwt.sign({ key: `patch-a-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: `patch-b-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenSpectator = jwt.sign({ key: `patch-spectator-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    const spectator = await connect(withPowCookie(`csgofriberg_guest=${tokenSpectator}`));
    let appliedEvents = 0;
    let roundOverEvents = 0;
    a.on('game:guess:applied', () => { appliedEvents += 1; });
    a.on('round:over', () => { roundOverEvents += 1; });
    try {
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 1, allowSpectators: true });
      createdRoomIds.push(created.room.id);
      expect(created.room.spectatorCount).toBe(0);
      expect(created.room).not.toHaveProperty('spectators');

      const joinedPatchPromise = onceEvent(a, 'room:patch');
      await emit(b, 'room:join', { roomId: created.room.id });
      const joinedPatch = await joinedPatchPromise;
      expect(joinedPatch).toMatchObject({
        roomId: created.room.id,
        baseVersion: created.room.stateVersion,
      });
      expect(joinedPatch.players.added).toHaveLength(1);

      const readyPatchPromise = onceEvent(a, 'room:patch');
      await emit(b, 'room:ready', { ready: true });
      const readyPatch = await readyPatchPromise;
      expect(readyPatch.players.updated).toContainEqual(expect.objectContaining({
        key: `g:patch-b-${stamp}`,
        ready: true,
      }));
      const spectatorPatchPromise = onceEvent(a, 'room:patch');
      const spectatorJoined = await emit(spectator, 'room:join', {
        roomId: created.room.id,
        spectate: true,
      });
      const spectatorPatch = await spectatorPatchPromise;
      expect(spectatorPatch.spectatorCount).toBe(1);
      expect(spectatorPatch.spectators).toBeUndefined();
      expect(spectatorJoined.room.spectatorCount).toBe(1);
      expect(spectatorJoined.room.spectators).toBeUndefined();

      expect((await emit(a, 'game:start')).ok).toBe(true);
      const active = await getRoom(created.room.id);
      expect(active?.targetPlayerId).toEqual(expect.any(Number));
      const eventId = `patch-guess-${stamp}`;
      const matchOverPromise = onceEvent(a, 'match:over');
      const guessAck = await emit(a, 'game:guess', {
        playerId: active!.targetPlayerId,
        roundId: active!.round,
        eventId,
      });
      const matchOver = await matchOverPromise;
      expect(guessAck).toMatchObject({ cooldownMs: expect.any(Number) });
      expect(guessAck.eventId).toBeUndefined();
      expect(guessAck.feedback).toBeUndefined();
      expect(guessAck.room).toBeUndefined();
      expect(Object.keys(matchOver).sort()).toEqual(['room', 'serverNow']);
      expect(matchOver.serverNow).toEqual(expect.any(Number));
      expect(matchOver.room.matchResult).toMatchObject({ reason: 'score' });
      expect(appliedEvents).toBe(0);
      expect(roundOverEvents).toBe(0);
    } finally {
      a.disconnect();
      b.disconnect();
      spectator.disconnect();
    }
  });

  it('does not write the room when ready is sent during an active round and rate limits spam', async () => {
    const stamp = Date.now();
    const tokenA = jwt.sign({ key: `ready-spam-a-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: `ready-spam-b-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'normal', boType: 3 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      expect((await emit(a, 'game:start')).ok).toBe(true);
      const before = await getRoom(created.room.id);

      expect((await emit(b, 'room:ready', { ready: false })).code).toBe('NOT_IN_WAITING_ROOM');
      const spamResults = await Promise.all(
        Array.from({ length: 10 }, () => emit(b, 'room:ready', { ready: false }))
      );
      expect(spamResults.some((result) => result.code === 'RATE_LIMITED')).toBe(true);

      const after = await getRoom(created.room.id);
      expect(after?.revision).toBe(before?.revision);
      expect(after?.status).toBe('playing');
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('hides opponent guess details from players but not spectators', async () => {
    const stamp = Date.now();
    const keyA = `hidden-a-${stamp}`;
    const keyB = `hidden-b-${stamp}`;
    const keySpectator = `hidden-spectator-${stamp}`;
    const tokenA = jwt.sign({ key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const spectatorToken = jwt.sign(
      { key: keySpectator, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    const spectator = await connect(withPowCookie(`csgofriberg_guest=${spectatorToken}`));
    try {
      const created = await emit(a, 'room:create', {
        dbType: 'normal',
        boType: 3,
        allowSpectators: true,
        anonymous: true,
      });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(spectator, 'room:join', { roomId: created.room.id, spectate: true });
      await emit(b, 'room:ready');
      expect((await emit(a, 'game:start')).ok).toBe(true);

      const syncedA = await emit(a, 'room:sync');
      const stored = JSON.parse(
        (await redis()!.get(redisKey(`room:${created.room.id}`)))!
      );
      const [wrongGuess] = await db('players')
        .whereNot({ id: stored.targetPlayerId })
        .select('id')
        .limit(1);
      const opponentEvent = onceEvent(b, 'game:guess:applied');
      const spectatorEvent = onceEvent(spectator, 'game:guess:applied');
      const guessed = await emit(a, 'game:guess', {
        playerId: wrongGuess.id,
        roundId: syncedA.room.roundId,
        eventId: `hidden-${stamp}-0001`,
      });
      expect(guessed.feedback).toBeUndefined();
      expect(guessed.cooldownMs).toEqual(expect.any(Number));

      const hiddenUpdate = await opponentEvent;
      expect(hiddenUpdate.feedback).toMatchObject({ hidden: true, correct: false });
      expect(hiddenUpdate.eventId).toBeUndefined();
      expect(hiddenUpdate.guessCount).toBeUndefined();
      expect(hiddenUpdate.feedback).not.toHaveProperty('playerId');
      expect(hiddenUpdate.feedback).not.toHaveProperty('nickname');
      expect(hiddenUpdate.feedback.attributes).not.toHaveProperty('region');
      expect(hiddenUpdate.feedback.attributes.team).not.toHaveProperty('value');

      const spectatorUpdate = await spectatorEvent;
      expect(spectatorUpdate.feedback.playerId).toBe(wrongGuess.id);
      expect(spectatorUpdate.eventId).toBeUndefined();
      expect(spectatorUpdate.guessCount).toBeUndefined();
      expect(spectatorUpdate.feedback.nickname).toEqual(expect.any(String));
      expect(spectatorUpdate.feedback.attributes).not.toHaveProperty('region');
      expect(spectatorUpdate.feedback.attributes.team).toHaveProperty('value');

      const syncedB = await emit(b, 'room:sync');
      expect(syncedB.room.anonymous).toBe(true);
      expect(syncedB.room.players.map((player: any) => player.name)).toEqual([
        guestNameFromKey(keyA),
        guestNameFromKey(keyB),
      ]);
      const opponentView = syncedB.room.players.find((player: any) => player.key === `g:${keyA}`);
      expect(opponentView.guesses[0]).toMatchObject({ hidden: true, correct: false });
      expect(opponentView.guesses[0]).not.toHaveProperty('playerId');
      expect(opponentView.guesses[0]).not.toHaveProperty('nickname');
      expect(opponentView.guesses[0].attributes.nationality).not.toHaveProperty('value');

      const spectatorSync = await emit(spectator, 'room:sync');
      expect(spectatorSync.room.players.map((player: any) => player.name)).toEqual([
        guestNameFromKey(keyA),
        guestNameFromKey(keyB),
      ]);
      const spectatorView = spectatorSync.room.players.find(
        (player: any) => player.key === `g:${keyA}`
      );
      expect(spectatorView.guesses[0].playerId).toBe(wrongGuess.id);
      expect(spectatorView.guesses[0].nickname).toEqual(expect.any(String));
      expect(spectatorView.guesses[0].attributes.nationality).toHaveProperty('value');
    } finally {
      a.disconnect();
      b.disconnect();
      spectator.disconnect();
    }
  });

  it('uses incremental guesses and reloads the Redis script after SCRIPT FLUSH', async () => {
    const stamp = Date.now();
    const tokenA = jwt.sign({ key: `script-a-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: `script-b-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'normal', boType: 3 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready');
      expect((await emit(a, 'game:start')).ok).toBe(true);
      const synced = await emit(a, 'room:sync');
      const stored = JSON.parse((await redis()!.get(redisKey(`room:${created.room.id}`)))!);
      const wrongGuesses = await db('players')
        .whereNot({ id: stored.targetPlayerId })
        .select('id')
        .limit(2);

      const firstAppliedPromise = onceEvent(a, 'game:guess:applied');
      const first = await emit(a, 'game:guess', {
        playerId: wrongGuesses[0].id,
        roundId: synced.room.roundId,
        eventId: `script-${stamp}-0001`,
      });
      const firstApplied = await firstAppliedPromise;
      expect(first.feedback).toBeUndefined();
      expect(firstApplied.feedback.playerId).toBe(wrongGuesses[0].id);
      expect(first).not.toHaveProperty('room');
      const identityA = `g:script-a-${stamp}`;
      const snapshotAfterFirst = JSON.parse(
        (await redis()!.get(redisKey(`room:${created.room.id}`)))!
      );
      expect(snapshotAfterFirst.players.find((player: any) => player.key === identityA).guesses)
        .toHaveLength(0);
      const hotGuesses = JSON.parse((await redis()!.hGet(
        redisKey(`room:${created.room.id}:guesses`),
        identityA
      ))!);
      expect(hotGuesses).toHaveLength(1);
      expect((await getRoom(created.room.id))!.players.find(
        (player) => player.key === identityA
      )!.guesses).toHaveLength(1);
      const bucket = Math.floor(Date.now() / 10_000);
      const rateKeys = [bucket, bucket - 1].map((value) => redisKey(`rl:socket:guess:${value}`));
      const rateKey = (await Promise.all(rateKeys.map(async (key) => ({
        key,
        exists: await redis()!.hExists(key, identityA),
      })))).find((item) => item.exists)?.key;
      expect(rateKey).toBeTruthy();
      const fieldTtl = await redis()!.sendCommand([
        'HTTL', rateKey!, 'FIELDS', '1', identityA,
      ]) as number[];
      expect(Number(fieldTtl[0])).toBeGreaterThan(0);

      await redis()!.sendCommand(['SCRIPT', 'FLUSH']);
      const coolingDown = await emit(a, 'game:guess', {
        playerId: wrongGuesses[1].id,
        roundId: synced.room.roundId,
        eventId: `script-${stamp}-0002`,
      });
      expect(coolingDown.code).toBe('GUESS_COOLDOWN');
      expect(coolingDown.retryAfterMs).toBeGreaterThan(0);
      expect(coolingDown.retryAfterMs).toBeLessThanOrEqual(3_000);
      await new Promise((resolve) => setTimeout(resolve, coolingDown.retryAfterMs + 25));

      const secondAppliedPromise = onceEvent(a, 'game:guess:applied');
      const second = await emit(a, 'game:guess', {
        playerId: wrongGuesses[1].id,
        roundId: synced.room.roundId,
        eventId: `script-${stamp}-0003`,
      });
      const secondApplied = await secondAppliedPromise;
      expect(second.feedback).toBeUndefined();
      expect(secondApplied.feedback.playerId).toBe(wrongGuesses[1].id);
      expect(second).not.toHaveProperty('room');

      for (let index = 4; index <= 12; index += 1) {
        const repeated = await emit(a, 'game:guess', {
          playerId: wrongGuesses[1].id,
          roundId: synced.room.roundId,
          eventId: `script-${stamp}-${String(index).padStart(4, '0')}`,
        });
        expect(repeated.code).toBe('ALREADY_GUESSED');
      }
      const limited = await emit(a, 'game:guess', {
        playerId: wrongGuesses[1].id,
        roundId: synced.room.roundId,
        eventId: `script-${stamp}-0013`,
      });
      expect(limited.code).toBe('RATE_LIMITED');
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('disables spectating by default', async () => {
    const stamp = Date.now();
    const tokenA = jwt.sign(
      { key: `private-a-${stamp}`, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const tokenB = jwt.sign(
      { key: `private-b-${stamp}`, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const tokenC = jwt.sign(
      { key: `private-c-${stamp}`, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    const spectator = await connect(withPowCookie(`csgofriberg_guest=${tokenC}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'normal', boType: 3 });
      createdRoomIds.push(created.room.id);
      expect(created.room.allowSpectators).toBe(false);
      expect(created.room.anonymous).toBe(false);
      const joinedPatchPromise = onceEvent(a, 'room:patch');
      await emit(b, 'room:join', { roomId: created.room.id });
      expect((await joinedPatchPromise).players.added).toHaveLength(1);
      const beforeRejectedJoin = await getRoom(created.room.id);

      const rejected = await emit(spectator, 'room:join', {
        roomId: created.room.id,
        spectate: true,
      });
      expect(rejected.code).toBe('SPECTATING_DISABLED');
      const afterRejectedJoin = await getRoom(created.room.id);
      expect(afterRejectedJoin?.revision).toBe(beforeRejectedJoin?.revision);

      const synced = await emit(a, 'room:sync');
      expect(synced.room.spectatorCount).toBe(0);
    } finally {
      a.disconnect();
      b.disconnect();
      spectator.disconnect();
    }
  });

  it('limits concurrent sockets for one identity', async () => {
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../config');
    const token = jwt.default.sign(
      { key: `socket-limit-${Date.now()}`, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const cookie = withPowCookie(`csgofriberg_guest=${token}`);
    const sockets = await Promise.all([connect(cookie), connect(cookie), connect(cookie)]);
    try {
      await expect(connect(cookie)).rejects.toMatchObject({ message: 'TOO_MANY_CONNECTIONS' });
    } finally {
      sockets.forEach((socket) => socket.disconnect());
    }
  });

  it('restores room state after reconnect without forfeiting', async () => {
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../config');
    const stamp = Date.now();
    const tokenA = jwt.default.sign({ key: `reconnect-a-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.default.sign({ key: `reconnect-b-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const cookieA = withPowCookie(`csgofriberg_guest=${tokenA}`);
    const cookieB = withPowCookie(`csgofriberg_guest=${tokenB}`);
    let a = await connect(cookieA);
    const b = await connect(cookieB);
    try {
      const created = await emit(a, 'room:create', { dbType: 'normal', boType: 3 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready');
      await emit(a, 'game:start');
      const before = await emit(a, 'room:sync');
      a.disconnect();
      a = await connect(cookieA);
      const restored = await emit(a, 'room:sync');
      expect(restored.room.id).toBe(before.room.id);
      expect(restored.room.roundId).toBe(before.room.roundId);
      expect(restored.room.players.every((player: any) => player.connected)).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, config.disconnectForfeitMs + 100));
      const afterGrace = await emit(a, 'room:sync');
      expect(afterGrace.room.status).toBe('playing');
      await emit(a, 'room:leave');
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('keeps a waiting-room seat during a short network interruption', async () => {
    const stamp = Date.now();
    const keyA = `waiting-reconnect-a-${stamp}`;
    const keyB = `waiting-reconnect-b-${stamp}`;
    const cookieA = withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`);
    const cookieB = withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`);
    const a = await connect(cookieA);
    let b = await connect(cookieB);
    try {
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 3 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      b.disconnect();
      for (let attempt = 0; attempt < 20; attempt++) {
        const raw = await redis()!.get(redisKey(`room:${created.room.id}`));
        const player = raw && JSON.parse(raw).players.find((item: any) => item.key === `g:${keyB}`);
        if (player && !player.connected) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      const offline = await emit(a, 'room:sync');
      expect(offline.room.players).toHaveLength(2);
      expect(offline.room.players.find((player: any) => player.key === `g:${keyB}`).connected)
        .toBe(false);

      b = await connect(cookieB);
      const restored = await emit(b, 'room:sync');
      expect(restored.room.players).toHaveLength(2);
      expect(restored.room.players.find((player: any) => player.key === `g:${keyB}`).connected)
        .toBe(true);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('restores a spectator after a short network interruption', async () => {
    const stamp = Date.now();
    const ownerToken = jwt.sign({ key: `spectator-owner-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const spectatorKey = `spectator-reconnect-${stamp}`;
    const spectatorCookie = withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: spectatorKey, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`);
    const owner = await connect(withPowCookie(`csgofriberg_guest=${ownerToken}`));
    let spectator = await connect(spectatorCookie);
    try {
      const created = await emit(owner, 'room:create', {
        dbType: 'easy', boType: 3, allowSpectators: true,
      });
      createdRoomIds.push(created.room.id);
      await emit(spectator, 'room:join', { roomId: created.room.id, spectate: true });
      spectator.disconnect();
      await new Promise((resolve) => setTimeout(resolve, 50));
      spectator = await connect(spectatorCookie);
      const restored = await emit(spectator, 'room:sync');
      expect(restored.role).toBe('spectator');
      expect(restored.room.id).toBe(created.room.id);
      expect(restored.room.spectatorCount).toBe(1);
    } finally {
      owner.disconnect();
      spectator.disconnect();
    }
  });

  it('keeps explicit ready requests idempotent when an ack is retried', async () => {
    const stamp = Date.now();
    const tokenA = jwt.sign({ key: `ready-a-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: `ready-b-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 3 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      expect((await emit(b, 'room:ready', { ready: true })).ok).toBe(true);
      expect((await emit(b, 'room:ready', { ready: true })).ok).toBe(true);
      const synced = await emit(a, 'room:sync');
      expect(synced.room.players.find((player: any) => player.key === `g:ready-b-${stamp}`).ready)
        .toBe(true);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('rejects mutations from a socket replaced by a newer connection', async () => {
    const stamp = Date.now();
    const keyA = `takeover-a-${stamp}`;
    const keyB = `takeover-b-${stamp}`;
    const cookieA = withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyA, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    )}`);
    const cookieB = withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyB, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    )}`);
    const oldA = await connect(cookieA);
    const b = await connect(cookieB);
    let newA: ClientSocket | null = null;
    try {
      const created = await emit(oldA, 'room:create', { dbType: 'easy', boType: 3 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      newA = await connect(cookieA);
      expect((await emit(newA, 'room:sync')).room.id).toBe(created.room.id);
      expect((await emit(oldA, 'room:leave')).code).toBe('STALE_CONNECTION');
      expect((await emit(oldA, 'room:ready', { ready: false })).code).toBe('STALE_CONNECTION');
      expect((await emit(newA, 'room:sync')).room.id).toBe(created.room.id);
    } finally {
      oldA.disconnect();
      newA?.disconnect();
      b.disconnect();
    }
  });

  it('ends as a draw instead of choosing a random winner when both players disconnect', async () => {
    const stamp = Date.now();
    const keyA = `double-offline-a-${stamp}`;
    const keyB = `double-offline-b-${stamp}`;
    const tokenA = jwt.sign({ key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    const created = await emit(a, 'room:create', { dbType: 'easy', boType: 3 });
    createdRoomIds.push(created.room.id);
    await emit(b, 'room:join', { roomId: created.room.id });
    await emit(b, 'room:ready', { ready: true });
    await emit(a, 'game:start');
    a.disconnect();
    b.disconnect();

    const roomKey = redisKey(`room:${created.room.id}`);

    let finished: any = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const current = await redis()!.get(roomKey);
      finished = current ? JSON.parse(current) : null;
      if (finished?.matchResult?.reason === 'disconnect_timeout') break;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    const schedules = await redis()!.zRangeWithScores(redisKey('room:schedules'), 0, -1);
    expect(finished?.matchResult, JSON.stringify({ finished, schedules })).toMatchObject({
      winnerKey: null,
      reason: 'disconnect_timeout',
    });
  });

  it('restores the final match result from the room snapshot', async () => {
    const stamp = Date.now();
    const keyA = `result-a-${stamp}`;
    const keyB = `result-b-${stamp}`;
    const tokenA = jwt.sign({ key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 1 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(a, 'game:start');
      const before = await emit(a, 'room:sync');
      const stored = JSON.parse((await redis()!.get(redisKey(`room:${created.room.id}`)))!);
      const matchOverPromise = onceEvent(a, 'match:over');
      const guessed = await emit(a, 'game:guess', {
        playerId: stored.targetPlayerId,
        roundId: before.room.roundId,
        eventId: `result-${stamp}-0001`,
      });
      const matchOver = await matchOverPromise;
      expect(guessed.room).toBeUndefined();
      expect(matchOver.room.status).toBe('finished');
      const restored = await emit(a, 'room:sync');
      expect(restored.room.matchResult).toMatchObject({
        winnerKey: `g:${keyA}`,
        reason: 'score',
      });
      expect(restored.room.roundResult).toBeNull();
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('returns the current room when creating or joining another room', async () => {
    const stamp = Date.now();
    const owner = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: `already-owner-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    const other = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: `already-other-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    try {
      const current = await emit(owner, 'room:create', { dbType: 'easy', boType: 3 });
      const target = await emit(other, 'room:create', { dbType: 'easy', boType: 3 });
      createdRoomIds.push(current.room.id, target.room.id);

      const repeatedCreate = await emit(owner, 'room:create', { dbType: 'normal', boType: 1 });
      expect(repeatedCreate).toMatchObject({
        code: 'ALREADY_IN_ROOM',
        role: 'player',
        room: { id: current.room.id },
      });
      const crossJoin = await emit(owner, 'room:join', { roomId: target.room.id });
      expect(crossJoin).toMatchObject({
        code: 'ALREADY_IN_ROOM',
        role: 'player',
        room: { id: current.room.id },
      });
    } finally {
      owner.disconnect();
      other.disconnect();
    }
  });

  it('allows surrendering only the active round and scores it once', async () => {
    const stamp = Date.now();
    const keyA = `surrender-a-${stamp}`;
    const keyB = `surrender-b-${stamp}`;
    const a = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 3 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(a, 'game:start');
      const active = await emit(a, 'room:sync');
      let matchOverEvents = 0;
      b.on('match:over', () => { matchOverEvents += 1; });
      const roundOverPromise = onceEvent(b, 'round:over');
      const results = await Promise.all([
        emit(a, 'game:surrender-round', { roundId: active.room.roundId }),
        emit(a, 'game:surrender-round', { roundId: active.room.roundId }),
      ]);
      const roundOver = await roundOverPromise;
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.some((result) => result.code === 'NO_ACTIVE_ROUND')).toBe(true);
      expect(Object.keys(roundOver).sort()).toEqual(['room', 'serverNow']);
      expect(roundOver.serverNow).toEqual(expect.any(Number));
      expect(matchOverEvents).toBe(0);

      const synced = await emit(b, 'room:sync');
      expect(synced.room.status).toBe('round_over');
      expect(synced.room.roundResult).toMatchObject({
        winnerKey: `g:${keyB}`,
        reason: 'surrender',
        nextRoundAt: expect.any(Number),
      });
      expect(synced.room.players.find((player: any) => player.key === `g:${keyB}`).score).toBe(1);
      expect(synced.room.players.find((player: any) => player.key === `g:${keyA}`).score).toBe(0);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('clears the surrendering player room mapping after leaving the match', async () => {
    const stamp = Date.now();
    const keyA = `surrender-leave-a-${stamp}`;
    const keyB = `surrender-leave-b-${stamp}`;
    const identityA = `g:${keyA}`;
    const a = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 3 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(a, 'game:start');
      const active = await emit(a, 'room:sync');

      expect((await emit(a, 'game:surrender-round', { roundId: active.room.roundId })).ok).toBe(true);
      expect((await emit(a, 'room:leave')).ok).toBe(true);

      const finished = await emit(b, 'room:sync');
      expect(finished.room.matchResult).toMatchObject({
        winnerKey: `g:${keyB}`,
        reason: 'opponent_left',
      });

      expect(await redis()!.get(redisKey(`identity-room:${identityA}`))).toBeNull();
      expect(await emit(a, 'room:sync')).toMatchObject({ code: 'NOT_IN_ROOM' });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('finishes a BO1 match when the active round is surrendered', async () => {
    const stamp = Date.now();
    const keyA = `surrender-bo1-a-${stamp}`;
    const keyB = `surrender-bo1-b-${stamp}`;
    const a = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 1 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(a, 'game:start');
      const active = await emit(a, 'room:sync');
      expect((await emit(a, 'game:surrender-round', { roundId: active.room.roundId })).ok).toBe(true);
      const synced = await emit(b, 'room:sync');
      expect(synced.room.status).toBe('finished');
      expect(synced.room.matchResult).toMatchObject({
        winnerKey: `g:${keyB}`,
        reason: 'score',
      });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('does not jump back when an old room is saved after a new room starts', async () => {
    const stamp = Date.now();
    const keyA = `room-switch-a-${stamp}`;
    const keyB = `room-switch-b-${stamp}`;
    const a = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${jwt.sign(
      { key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' }
    )}`));
    try {
      const first = await emit(a, 'room:create', { dbType: 'easy', boType: 1 });
      createdRoomIds.push(first.room.id);
      await emit(b, 'room:join', { roomId: first.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(a, 'game:start');
      const firstStored = JSON.parse((await redis()!.get(redisKey(`room:${first.room.id}`)))!);
      await emit(a, 'game:guess', {
        playerId: firstStored.targetPlayerId,
        roundId: firstStored.round,
        eventId: `switch-${stamp}-first`,
      });
      await emit(a, 'room:leave');
      await emit(b, 'room:leave');

      const second = await emit(a, 'room:create', { dbType: 'easy', boType: 3 });
      createdRoomIds.push(second.room.id);
      await emit(b, 'room:join', { roomId: second.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(a, 'game:start');

      await withRoomLock(first.room.id, (oldRoom) => {
        oldRoom.updatedAt = Date.now();
      });

      expect(await redis()!.get(redisKey(`identity-room:g:${keyA}`))).toBe(second.room.id);
      expect(await redis()!.get(redisKey(`identity-room:g:${keyB}`))).toBe(second.room.id);
      expect((await emit(a, 'room:sync')).room.id).toBe(second.room.id);
      expect((await emit(b, 'room:sync')).room.id).toBe(second.room.id);
      expect((await getRoom(first.room.id))?.status).toBe('finished');
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('does not interrupt an established socket when its PoW pass expires', async () => {
    const token = jwt.sign(
      { key: `socket-expiry-${Date.now()}`, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const socket = await connect(withPowCookie(`csgofriberg_guest=${token}`, 1));
    try {
      await new Promise((resolve) => setTimeout(resolve, 1_100));
      expect(socket.connected).toBe(true);
      const synced = await emit(socket, 'room:sync');
      expect(synced.code).toBe('NOT_IN_ROOM');
    } finally {
      socket.disconnect();
    }
  });

  it('restricts live presence stats to admins and deduplicates their sockets', async () => {
    const stamp = Date.now();
    const guestToken = jwt.sign(
      { key: `presence-guest-${stamp}`, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const guest = await connect(withPowCookie(`csgofriberg_guest=${guestToken}`));
    const [adminId] = await db('users')
      .insert({
        username: `presence-admin-${stamp}`,
        password_hash: 'not-used',
        role: 'admin',
        token_version: 0,
      })
      .returning('id')
      .then((rows) => rows.map((row: any) => typeof row === 'object' ? row.id : row));
    const adminToken = signToken({ id: adminId, token_version: 0 });
    const adminCookie = withPowCookie(`csgofriberg_session=${adminToken}`);
    const adminA = await connect(adminCookie);
    const adminB = await connect(adminCookie);
    try {
      expect((await emit(guest, 'presence:subscribe')).code).toBe('FORBIDDEN');
      const subscribed = await emit(adminA, 'presence:subscribe');
      expect(subscribed.ok).toBe(true);
      expect(subscribed.stats).toMatchObject({
        onlineUsers: expect.any(Number),
        multiplayerRooms: expect.any(Number),
        singleGames: expect.any(Number),
      });
      expect(await redis()!.zScore(redisKey('presence:online'), `u:${adminId}`)).not.toBeNull();
      expect(await redis()!.zCard(redisKey(`connections:identity:u:${adminId}`))).toBe(2);
      expect(await redis()!.zCount(
        redisKey('presence:online'),
        '-inf',
        '+inf'
      )).toBeGreaterThanOrEqual(1);
    } finally {
      guest.disconnect();
      adminA.disconnect();
      adminB.disconnect();
      await db('users').where({ id: adminId }).del();
    }
  });

  it('tracks active multiplayer rooms until they are deleted', async () => {
    const stamp = Date.now();
    const guestToken = jwt.sign(
      { key: `presence-room-${stamp}`, typ: 'guest' },
      config.jwtSecret,
      { expiresIn: '1h' }
    );
    const socket = await connect(withPowCookie(`csgofriberg_guest=${guestToken}`));
    try {
      const created = await emit(socket, 'room:create', { dbType: 'easy', boType: 1 });
      createdRoomIds.push(created.room.id);
      expect(await redis()!.zScore(redisKey('presence:rooms'), created.room.id)).not.toBeNull();
      await emit(socket, 'room:leave');
      expect(await redis()!.zScore(redisKey('presence:rooms'), created.room.id)).toBeNull();
    } finally {
      socket.disconnect();
    }
  });
});
