import http from 'http';
import { AddressInfo } from 'net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Server } from 'socket.io';
import { io as clientIo, Socket as ClientSocket } from 'socket.io-client';
import { initDb } from '../../src/db/init';
import { db } from '../../src/db/knex';
import { initRedis, redis, redisKey } from '../../src/redis';
import { getDifficultyPlayers, getPlayer, initPlayerCache } from '../../src/services/playerCache';
import { compareGuess } from '../../src/services/gameService';
import { resolveSocketIp, setRecoveryWindow, setupSocket } from '../../src/socket';
import { browserFingerprint, POW_COOKIE } from '../../src/services/pow';
import jwt from 'jsonwebtoken';
import { config } from '../../src/config';
import { guestNameFromKey, signToken } from '../../src/middleware/auth';
import { cancelQueue, getRoom, getRoomForIdentity, queueOrTakeOpponent, withRoomLock } from '../../src/services/roomStore';
import {
  clearMatchmakingCooldown,
  readyExitPenaltyMultiplier,
  reduceMatchmakingCooldown,
  recordMatchmakingExit,
} from '../../src/services/matchmakingCooldown';

let server: http.Server;
let io: Server;
let baseUrl: string;
let stopSocket: (() => Promise<void>) | undefined;
const createdRoomIds: string[] = [];
const createdTestUserIds: number[] = [];
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
      fp: browserFingerprint(TEST_USER_AGENT, '127.0.0.1'),
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

async function createTestUser(verified: boolean): Promise<{ id: number; key: string; cookie: string }> {
  const suffix = `${Date.now()}${Math.floor(Math.random() * 10_000)}`;
  const username = `socket_test_${suffix}`;
  const email = `${username}@example.com`;
  const inserted = await db('users').insert({
    username,
    password_hash: 'test-password-hash',
    role: 'user',
    token_version: 0,
    email,
    email_verified_at: verified ? new Date().toISOString() : null,
  }).returning('id');
  const id = Number(typeof inserted[0] === 'object' ? inserted[0].id : inserted[0]);
  createdTestUserIds.push(id);
  const token = signToken({ id, token_version: 0 });
  return {
    id,
    key: `u:${id}`,
    cookie: withPowCookie(`csgofriberg_session=${token}`),
  };
}

function createVerifiedUser() {
  return createTestUser(true);
}

function createUnverifiedUser() {
  return createTestUser(false);
}

describe('multiplayer socket integration', () => {
  beforeAll(async () => {
    config.disconnectForfeitMs = 300;
    config.matchReadyTimeoutMs = 600;
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
    const queueKey = redisKey('matchmaking:verified:easy');
    const restrictedQueueKey = redisKey('matchmaking:restricted:easy');
    await client.zAdd(queueKey, { score: Date.now() - 301_000, value: staleIdentity });

    expect(await queueOrTakeOpponent('easy', identity)).toBeNull();
    expect(await client.zScore(queueKey, staleIdentity)).toBeNull();
    expect(await client.zScore(queueKey, identity.key)).not.toBeNull();

    const restrictedIdentity = {
      key: `u:restricted-queue-${stamp}`,
      userId: 123,
      name: 'restricted-queue-test',
      socketId: `restricted-queue-socket-${stamp}`,
      matchmakingPool: 'restricted' as const,
    };
    expect(await queueOrTakeOpponent('easy', restrictedIdentity)).toBeNull();
    expect(await client.zScore(queueKey, restrictedIdentity.key)).toBeNull();
    expect(await client.zScore(restrictedQueueKey, restrictedIdentity.key)).not.toBeNull();
    const secondRestrictedIdentity = {
      ...restrictedIdentity,
      key: `u:restricted-queue-second-${stamp}`,
      userId: 124,
      socketId: `restricted-queue-socket-second-${stamp}`,
    };
    expect(await queueOrTakeOpponent('easy', secondRestrictedIdentity)).toBeNull();
    expect(await client.zScore(restrictedQueueKey, restrictedIdentity.key)).not.toBeNull();
    expect(await client.zScore(restrictedQueueKey, secondRestrictedIdentity.key)).not.toBeNull();

    await client.del(redisKey(`match-queue:${identity.key}`));
    await cancelQueue(identity.key);
    expect(await client.zScore(queueKey, identity.key)).toBeNull();
    expect(await client.get(redisKey(`match-profile:${identity.key}`))).toBeNull();
    await cancelQueue(restrictedIdentity.key);
    await cancelQueue(secondRestrictedIdentity.key);
    expect(await client.zScore(restrictedQueueKey, restrictedIdentity.key)).toBeNull();
    expect(await client.zScore(restrictedQueueKey, secondRestrictedIdentity.key)).toBeNull();
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
      expect(await emit(socket, 'match:rematch-want', { wanted: 'yes' }))
        .toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(socket, 'match:rematch-respond', { accept: 'yes' }))
        .toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(socket, 'game:guess', {
        playerId: '1',
        roundId: 1,
        eventId: 'short',
      })).toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(socket, 'match:start', { dbType: ['easy'] }))
        .toEqual({ code: 'VALIDATION_FAILED' });
    } finally {
      socket.disconnect();
    }
  });

  it('doubles matchmaking exit cooldowns and halves the stored cooldown after normal matches', async () => {
    const identity = `g:cooldown-${Date.now()}`;
    const halfIdentity = `g:cooldown-half-${Date.now()}`;
    const expectRemaining = (retryAt: number, minMs: number, maxMs: number) => {
      const remaining = retryAt - Date.now();
      expect(remaining).toBeGreaterThanOrEqual(minMs);
      expect(remaining).toBeLessThanOrEqual(maxMs);
    };
    try {
      expect(readyExitPenaltyMultiplier(2.99)).toBe(0);
      expect(readyExitPenaltyMultiplier(3)).toBe(0.5);
      expect(readyExitPenaltyMultiplier(4)).toBe(0.5);
      expect(readyExitPenaltyMultiplier(4.01)).toBe(1);
      expect(readyExitPenaltyMultiplier(null)).toBe(1);

      const first = await recordMatchmakingExit(identity);
      expectRemaining(first.retryAt, 19_000, 20_000);
      const second = await recordMatchmakingExit(identity);
      expectRemaining(second.retryAt, 39_000, 40_000);
      const third = await recordMatchmakingExit(identity);
      expectRemaining(third.retryAt, 79_000, 80_000);

      await reduceMatchmakingCooldown(identity);
      const afterReduction = await recordMatchmakingExit(identity);
      expectRemaining(afterReduction.retryAt, 79_000, 80_000);

      const half = await recordMatchmakingExit(halfIdentity, 0.5);
      expectRemaining(half.retryAt, 9_000, 10_000);
    } finally {
      await Promise.all([
        clearMatchmakingCooldown(identity),
        clearMatchmakingCooldown(halfIdentity),
      ]);
    }
  });

  it('creates multiplayer rooms with the beginner difficulty', async () => {
    const key = `beginner-room-${Date.now()}`;
    const token = jwt.sign({ key, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const socket = await connect(withPowCookie(`csgofriberg_guest=${token}`));
    try {
      const created = await emit(socket, 'room:create', { dbType: 'beginner', boType: 1 });
      expect(created.room).toMatchObject({
        dbType: 'beginner',
        boType: 1,
        maxGuesses: 8,
        guessIntervalMs: 1_500,
      });
      createdRoomIds.push(created.room.id);
    } finally {
      socket.disconnect();
    }
  });

  it('requires verified email matchmaking and enforces verified-only rooms', async () => {
    const guestKey = `match-policy-guest-${Date.now()}`;
    const guestToken = jwt.sign({ key: guestKey, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const guest = await connect(withPowCookie(`csgofriberg_guest=${guestToken}`));
    const unverified = await createUnverifiedUser();
    const verified = await createVerifiedUser();
    const unverifiedSocket = await connect(unverified.cookie);
    const verifiedSocket = await connect(verified.cookie);
    try {
      expect(await emit(guest, 'match:start', { dbType: 'easy' }))
        .toEqual({ code: 'EMAIL_VERIFICATION_REQUIRED' });
      expect(await emit(unverifiedSocket, 'match:start', { dbType: 'easy' }))
        .toEqual({ code: 'EMAIL_VERIFICATION_REQUIRED' });
      expect(await emit(verifiedSocket, 'match:start', { dbType: 'easy' }))
        .toEqual({ queued: true });
      await emit(verifiedSocket, 'match:cancel');

      const created = await emit(guest, 'room:create', {
        dbType: 'easy',
        boType: 1,
        verifiedOnly: true,
      });
      expect(created.room).toMatchObject({ verifiedOnly: true });
      createdRoomIds.push(created.room.id);

      expect(await emit(unverifiedSocket, 'room:join', { roomId: created.room.id }))
        .toEqual({ code: 'ROOM_VERIFIED_EMAIL_ONLY' });
      expect(await emit(verifiedSocket, 'room:join', { roomId: created.room.id }))
        .toMatchObject({ role: 'player', room: { verifiedOnly: true } });

      await db('users').where({ id: unverified.id }).update({ email_verified_at: new Date().toISOString() });
      expect(JSON.parse((await redis()!.get(redisKey(`auth:user:${unverified.id}`)))!))
        .toMatchObject({ emailVerified: false });
      expect(await emit(unverifiedSocket, 'match:start', { dbType: 'easy' }))
        .toEqual({ queued: true });
      await emit(unverifiedSocket, 'match:cancel');
    } finally {
      guest.disconnect();
      unverifiedSocket.disconnect();
      verifiedSocket.disconnect();
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
        const replay = [{
          round: 1,
          targetPlayerId: target.id,
          winnerKey: won ? `g:${keyB}` : `g:${keyA}`,
          reason: 'guessed',
          guessesByPlayer: {
            [`g:${keyA}`]: [target.id, target.id],
            [`g:${keyB}`]: won ? [target.id] : [target.id, target.id, target.id],
          },
        }];
        const [inserted] = await db('match_records')
          .insert({
            room_id: `${historyPrefix}-multi-${index}`,
            db_type: 'easy',
            bo_type: 3,
            winner_key: won ? `g:${keyB}` : `g:${keyA}`,
            finish_reason: 'score',
            replay: JSON.stringify(replay),
          })
          .returning('id');
        const matchId = typeof inserted === 'object' ? inserted.id : inserted;
        await db('match_players').insert([
          {
            match_id: matchId,
            player_key: `g:${keyB}`,
            player_name: guestNameFromKey(keyB),
            score: won ? 2 : 1,
            is_winner: won,
          },
          {
            match_id: matchId,
            player_key: `g:${keyA}`,
            player_name: guestNameFromKey(keyA),
            score: won ? 1 : 2,
            is_winner: !won,
          },
        ]);
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
          multi: {
            games: 2,
            wins: 1,
            losses: 1,
            winRate: 0.5,
            recentAverageWinningGuesses: 1,
            recentMatches: expect.arrayContaining([
              expect.objectContaining({
                result: expect.stringMatching(/won|lost/),
                opponentDisplayId: guestNameFromKey(keyA),
                rounds: [expect.objectContaining({ meGuesses: expect.any(Number) })],
              }),
            ]),
          },
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

  it('starts a matched room only after both players are ready', async () => {
    const userA = await createVerifiedUser();
    const userB = await createVerifiedUser();
    const a = await connect(userA.cookie);
    const b = await connect(userB.cookie);
    try {
      expect(await emit(a, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: true });
      const foundA = onceEvent(a, 'match:found');
      const foundB = onceEvent(b, 'match:found');
      expect(await emit(b, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: false });

      const [matchA, matchB] = await Promise.all([foundA, foundB]);
      expect(matchA.room.id).toBe(matchB.room.id);
      expect(matchA.room).toMatchObject({
        status: 'waiting',
        matchmaking: true,
        rematchAllowed: true,
        round: 0,
        players: [{ ready: false }, { ready: false }],
      });
      expect(matchA.room.readyCheckEndsAt - matchA.serverNow).toBeGreaterThan(0);
      expect(matchA.room.readyCheckEndsAt - matchA.serverNow).toBeLessThanOrEqual(600);

      const synced = await emit(a, 'room:sync');
      createdRoomIds.push(synced.room.id);
      let startedEarly = false;
      a.once('round:start', () => { startedEarly = true; });
      expect(await emit(a, 'room:ready', { ready: true })).toEqual({ ok: true });
      await new Promise((resolve) => setTimeout(resolve, 80));
      expect(startedEarly).toBe(false);

      const roundA = onceEvent(a, 'round:start');
      const roundB = onceEvent(b, 'round:start');
      expect(await emit(b, 'room:ready', { ready: true })).toEqual({ ok: true });
      const [startedA, startedB] = await Promise.all([roundA, roundB]);
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
      expect(await emit(a, 'room:leave')).toEqual({ ok: true });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('destroys an expired ready check and penalizes only unready players', async () => {
    const userA = await createVerifiedUser();
    const userB = await createVerifiedUser();
    const a = await connect(userA.cookie);
    const b = await connect(userB.cookie);
    try {
      expect(await emit(a, 'match:start', { dbType: 'easy', anonymous: true })).toEqual({ queued: true });
      const foundA = onceEvent(a, 'match:found');
      const foundB = onceEvent(b, 'match:found');
      expect(await emit(b, 'match:start', { dbType: 'easy', anonymous: true })).toEqual({ queued: false });
      const [matched] = await Promise.all([foundA, foundB]);
      const roomId = matched.room.id;
      const recordId = (await getRoom(roomId))!.recordId;
      expect(await emit(a, 'room:ready', { ready: true })).toEqual({ ok: true });

      const endedA = onceEvent(a, 'match:ready-ended', 2_000);
      const endedB = onceEvent(b, 'match:ready-ended', 2_000);
      const [resultA, resultB] = await Promise.all([endedA, endedB]);
      expect(resultA).toMatchObject({ roomId, reason: 'timeout', penalized: false, retryAt: null });
      expect(resultB).toMatchObject({ roomId, reason: 'timeout', penalized: true });
      expect(await getRoom(roomId)).toBeNull();
      expect(await db('match_records').where({ room_id: recordId }).first()).toBeUndefined();

      expect(await emit(b, 'match:start', { dbType: 'easy', anonymous: true })).toMatchObject({
        code: 'MATCHMAKING_COOLDOWN',
        retryAt: resultB.retryAt,
      });
      expect(await emit(a, 'match:start', { dbType: 'easy', anonymous: true })).toEqual({ queued: true });
      await emit(a, 'match:cancel');
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('does not penalize a ready-check exit against an opponent averaging under three guesses', async () => {
    const stamp = Date.now();
    const userA = await createVerifiedUser();
    const userB = await createVerifiedUser();
    const keyA = userA.key;
    const historyRoomId = `match-leave-history-${stamp}`;
    const a = await connect(userA.cookie);
    const b = await connect(userB.cookie);
    try {
      const [target] = await db('players').select('id').limit(1);
      const [inserted] = await db('match_records').insert({
        room_id: historyRoomId,
        db_type: 'easy',
        bo_type: 1,
        winner_key: keyA,
        finish_reason: 'score',
        replay: JSON.stringify([{
          round: 1,
          targetPlayerId: target.id,
          winnerKey: keyA,
          reason: 'guessed',
          guessesByPlayer: {
            [keyA]: [target.id, target.id],
            [`g:history-opponent-${stamp}`]: [target.id, target.id, target.id],
          },
        }]),
      }).returning('id');
      const historyMatchId = typeof inserted === 'object' ? inserted.id : inserted;
      await db('match_players').insert([
        {
          match_id: historyMatchId,
          player_key: keyA,
          player_name: 'history-user',
          score: 1,
          is_winner: true,
        },
        {
          match_id: historyMatchId,
          player_key: `g:history-opponent-${stamp}`,
          player_name: guestNameFromKey(`history-opponent-${stamp}`),
          score: 0,
          is_winner: false,
        },
      ]);

      expect(await emit(a, 'match:start', { dbType: 'easy', anonymous: true })).toEqual({ queued: true });
      const foundA = onceEvent(a, 'match:found');
      const foundB = onceEvent(b, 'match:found');
      expect(await emit(b, 'match:start', { dbType: 'easy', anonymous: true })).toEqual({ queued: false });
      const [matched] = await Promise.all([foundA, foundB]);
      const roomId = matched.room.id;
      const recordId = (await getRoom(roomId))!.recordId;
      const opponentEnded = onceEvent(a, 'match:ready-ended');
      const left = await emit(b, 'room:leave');
      expect(left).toMatchObject({ ok: true, retryAt: null, serverNow: expect.any(Number) });
      expect(await opponentEnded).toMatchObject({ roomId, reason: 'opponent_left', penalized: false });
      expect(await getRoom(roomId)).toBeNull();
      expect(await db('match_records').where({ room_id: recordId }).first()).toBeUndefined();
      expect(await emit(b, 'match:start', { dbType: 'easy', anonymous: true })).toEqual({ queued: true });
      await emit(b, 'match:cancel');
    } finally {
      a.disconnect();
      b.disconnect();
      await db('match_records').where({ room_id: historyRoomId }).del();
    }
  });

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
    if (createdTestUserIds.length) {
      const matchIds = [...new Set(await db('match_players')
        .whereIn('user_id', createdTestUserIds)
        .pluck<number>('match_id'))];
      if (matchIds.length) await db('match_records').whereIn('id', matchIds).del();
      await db('users').whereIn('id', createdTestUserIds).del();
    }
  });

  it('serializes starts and rejects stale or duplicate guesses', async () => {
    const stamp = Date.now();
    const jwt = await import('jsonwebtoken');
    const { config } = await import('../../src/config');
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
        expect(result.cooldownMs).toBe(1_500);
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

  it('rejects reports for manually created rooms after settlement', async () => {
    const stamp = Date.now();
    const keyA = `created-report-a-${stamp}`;
    const keyB = `created-report-b-${stamp}`;
    const tokenA = jwt.sign({ key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    try {
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 1 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      expect((await emit(a, 'game:start')).ok).toBe(true);
      const active = await getRoom(created.room.id);
      const matchOver = onceEvent(a, 'match:over');
      await emit(a, 'game:guess', {
        playerId: active!.targetPlayerId,
        roundId: active!.round,
        eventId: `report-finish-${stamp}`,
      });
      await matchOver;

      expect(await emit(a, 'match:report', { description: 'created room' }))
        .toEqual({ code: 'REPORT_NOT_AVAILABLE' });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('accepts one post-match report per player in matchmaking only', async () => {
    const userA = await createVerifiedUser();
    const userB = await createVerifiedUser();
    const a = await connect(userA.cookie);
    const b = await connect(userB.cookie);
    try {
      expect(await emit(a, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: true });
      const foundA = onceEvent(a, 'match:found');
      const foundB = onceEvent(b, 'match:found');
      expect(await emit(b, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: false });
      const [matchA] = await Promise.all([foundA, foundB]);
      createdRoomIds.push(matchA.room.id);

      expect(await emit(a, 'match:report', { description: 'too early' }))
        .toEqual({ code: 'REPORT_NOT_AVAILABLE' });
      const roundA = onceEvent(a, 'round:start');
      const roundB = onceEvent(b, 'round:start');
      expect(await emit(a, 'room:ready', { ready: true })).toEqual({ ok: true });
      expect(await emit(b, 'room:ready', { ready: true })).toEqual({ ok: true });
      await Promise.all([roundA, roundB]);
      await withRoomLock(matchA.room.id, (room) => {
        room.players.find((player) => player.key === userA.key)!.score = 1;
        return { room };
      });
      const active = await getRoom(matchA.room.id);
      const matchOver = onceEvent(a, 'match:over');
      await emit(a, 'game:guess', {
        playerId: active!.targetPlayerId,
        roundId: active!.round,
        eventId: `matchmaking-report-finish-${Date.now()}`,
      });
      await matchOver;

      expect(await emit(a, 'match:report', { description: 'x'.repeat(51) }))
        .toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(a, 'match:report', { description: ' suspected automation ' }))
        .toEqual({ ok: true, reportSubmitted: true });
      expect((await emit(a, 'room:sync')).room.reportSubmitted).toBe(true);
      expect((await emit(b, 'room:sync')).room.reportSubmitted).toBe(false);
      expect(await emit(a, 'match:report', { description: 'again' }))
        .toEqual({ code: 'REPORT_ALREADY_SUBMITTED' });
      expect(await emit(b, 'match:report', { description: '' }))
        .toEqual({ ok: true, reportSubmitted: true });

      const storedReports = (await getRoom(matchA.room.id))!.reports;
      expect(storedReports.map((report) => ({
        reporterKey: report.reporterKey,
        reportedKey: report.reportedKey,
        description: report.description,
      }))).toEqual([
        { reporterKey: userA.key, reportedKey: userB.key, description: 'suspected automation' },
        { reporterKey: userB.key, reportedKey: userA.key, description: '' },
      ]);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('accepts a matchmaking report after reconnecting to a finished room', async () => {
    const userA = await createVerifiedUser();
    const userB = await createVerifiedUser();
    let a = await connect(userA.cookie);
    const b = await connect(userB.cookie);
    try {
      expect(await emit(a, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: true });
      const foundA = onceEvent(a, 'match:found');
      const foundB = onceEvent(b, 'match:found');
      expect(await emit(b, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: false });
      const [matchA] = await Promise.all([foundA, foundB]);
      createdRoomIds.push(matchA.room.id);

      const roundA = onceEvent(a, 'round:start');
      const roundB = onceEvent(b, 'round:start');
      expect(await emit(a, 'room:ready', { ready: true })).toEqual({ ok: true });
      expect(await emit(b, 'room:ready', { ready: true })).toEqual({ ok: true });
      await Promise.all([roundA, roundB]);
      await withRoomLock(matchA.room.id, (room) => {
        room.players.find((player) => player.key === userA.key)!.score = 1;
        return { room };
      });
      const active = await getRoom(matchA.room.id);
      const matchOver = onceEvent(a, 'match:over');
      await emit(a, 'game:guess', {
        playerId: active!.targetPlayerId,
        roundId: active!.round,
        eventId: `matchmaking-report-reconnect-${Date.now()}`,
      });
      await matchOver;

      const previousSocketId = a.id;
      a.disconnect();
      a = await connect(userA.cookie);
      expect(a.id).not.toBe(previousSocketId);

      const restored = await emit(a, 'room:sync');
      expect(restored.room).toMatchObject({ id: matchA.room.id, status: 'finished', matchmaking: true });
      expect((await getRoom(matchA.room.id))!.players.find((player) => player.key === userA.key)?.socketId)
        .toBe(a.id);
      expect(await emit(a, 'match:report', { description: 'report after reconnect' }))
        .toEqual({ ok: true, reportSubmitted: true });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('starts a rematch automatically after every online player wants another game', async () => {
    const stamp = Date.now();
    const keyA = `rematch-a-${stamp}`;
    const keyB = `rematch-b-${stamp}`;
    const tokenA = jwt.sign({ key: keyA, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: keyB, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    try {
      const created = await emit(a, 'room:create', {
        dbType: 'easy', boType: 1, maxGuesses: 11, guessIntervalMs: 2_500,
        roundDurationMs: 300_000,
      });
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

      const wantedEvent = onceEvent(b, 'match:rematch:update');
      expect(await emit(a, 'match:rematch-want', { wanted: true }))
        .toEqual({ ok: true, stateVersion: expect.any(Number) });
      const wanted = await wantedEvent;
      expect(wanted).toMatchObject({
        roomId: created.room.id,
        stateVersion: expect.any(Number),
        outcome: 'wanted',
        actorKey: `g:${keyA}`,
        acceptedKeys: [`g:${keyA}`],
        requiredKeys: [`g:${keyA}`, `g:${keyB}`],
      });
      expect(wanted).not.toHaveProperty('room');
      expect(wanted).not.toHaveProperty('players');
      expect(wanted).not.toHaveProperty('rematchInvite');
      expect(JSON.stringify(wanted).length).toBeLessThan(320);

      const startedEvent = onceEvent(a, 'match:rematch:update');
      const roundA = onceEvent(a, 'round:start');
      const roundB = onceEvent(b, 'round:start');
      expect(await emit(b, 'match:rematch-want', { wanted: true }))
        .toEqual({ ok: true, stateVersion: expect.any(Number) });
      expect(await startedEvent).toMatchObject({
        roomId: created.room.id,
        outcome: 'started',
        actorKey: `g:${keyB}`,
        stateVersion: expect.any(Number),
      });
      await Promise.all([roundA, roundB]);
      const rematchRoom = await getRoom(created.room.id);
      expect(rematchRoom?.recordId).not.toBe(originalRecordId);
      expect(rematchRoom?.players.map((player) => ({ key: player.key, ready: player.ready, score: player.score })))
        .toEqual([
          { key: `g:${keyA}`, ready: true, score: 0 },
          { key: `g:${keyB}`, ready: true, score: 0 },
        ]);
      expect(rematchRoom?.replayRounds).toEqual([]);
      expect(rematchRoom).toMatchObject({
        maxGuesses: 11,
        guessIntervalMs: 2_500,
        roundDurationMs: 300_000,
      });
      const restarted = await getRoom(created.room.id);
      expect(restarted).toMatchObject({ status: 'playing', round: 1 });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('waits for every online player before starting a three-player rematch', async () => {
    const stamp = Date.now();
    const keys = [`rematch-3-a-${stamp}`, `rematch-3-b-${stamp}`, `rematch-3-c-${stamp}`];
    const sockets = await Promise.all(keys.map(async (key) => connect(withPowCookie(
      `csgofriberg_guest=${jwt.sign({ key, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' })}`
    ))));
    const [a, b, c] = sockets;
    try {
      const created = await emit(a, 'room:create', {
        dbType: 'easy', boType: 1, maxPlayers: 3, guessIntervalMs: 0,
      });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(c, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(c, 'room:ready', { ready: true });
      expect((await emit(a, 'game:start')).ok).toBe(true);

      const active = await getRoom(created.room.id);
      const matchOver = onceEvent(a, 'match:over');
      await emit(a, 'game:guess', {
        playerId: active!.targetPlayerId,
        roundId: active!.round,
        eventId: `rematch-3-finish-${stamp}`,
      });
      await matchOver;

      expect((await emit(a, 'match:rematch-want', { wanted: true })).ok).toBe(true);
      expect((await emit(b, 'match:rematch-want', { wanted: true })).ok).toBe(true);
      expect(await getRoom(created.room.id)).toMatchObject({
        status: 'finished',
        rematchAcceptedKeys: [`g:${keys[0]}`, `g:${keys[1]}`],
        rematchRequiredKeys: [`g:${keys[0]}`, `g:${keys[1]}`, `g:${keys[2]}`],
      });

      const startedEvent = onceEvent(a, 'match:rematch:update');
      const rounds = sockets.map((socket) => onceEvent(socket, 'round:start'));
      expect((await emit(c, 'match:rematch-want', { wanted: true })).ok).toBe(true);
      expect(await startedEvent).toMatchObject({
        roomId: created.room.id,
        outcome: 'started',
        actorKey: `g:${keys[2]}`,
      });
      await Promise.all(rounds);
      expect(await getRoom(created.room.id)).toMatchObject({ status: 'playing', round: 1 });
    } finally {
      sockets.forEach((socket) => socket.disconnect());
    }
  });

  it('runs a three-player classic room and eliminates leavers while the others continue', async () => {
    const stamp = Date.now();
    const keys = [`multi-a-${stamp}`, `multi-b-${stamp}`, `multi-c-${stamp}`];
    const sockets = await Promise.all(keys.map(async (key) => connect(withPowCookie(
      `csgofriberg_guest=${jwt.sign({ key, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' })}`
    ))));
    const [a, b, c] = sockets;
    try {
      const created = await emit(a, 'room:create', {
        dbType: 'easy', boType: 3, maxPlayers: 3, guessIntervalMs: 0,
      });
      createdRoomIds.push(created.room.id);
      expect(created.room.maxPlayers).toBe(3);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(c, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(c, 'room:ready', { ready: true });
      expect((await emit(a, 'game:start')).ok).toBe(true);

      const active = await getRoom(created.room.id);
      const wrongGuess = getDifficultyPlayers('easy').find((player) => player.id !== active!.targetPlayerId)!;
      const hiddenEvent = onceEvent(b, 'game:guess:applied');
      await emit(a, 'game:guess', {
        playerId: wrongGuess.id,
        roundId: active!.round,
        eventId: `multi-hidden-${stamp}`,
      });
      expect((await hiddenEvent).feedback).toMatchObject({ hidden: true });

      expect((await emit(a, 'room:leave')).ok).toBe(true);
      expect(await getRoomForIdentity(`g:${keys[0]}`)).toBeNull();
      expect((await getRoom(created.room.id))?.players.find((player) => player.key === `g:${keys[0]}`))
        .toMatchObject({ eliminated: true, eliminationReason: 'player_left' });
      expect((await emit(a, 'room:join', { roomId: created.room.id })).code).toBe('PLAYER_ELIMINATED');

      const matchOver = onceEvent(b, 'match:over');
      expect((await emit(c, 'room:leave')).ok).toBe(true);
      expect((await matchOver).room.matchResult).toMatchObject({
        winnerKey: `g:${keys[1]}`,
        reason: 'last_player_standing',
      });
    } finally {
      sockets.forEach((socket) => socket.disconnect());
    }
  });

  it('runs four-player relay rooms with shared guesses and strict turn rotation', async () => {
    const stamp = Date.now();
    const keys = ['a', 'b', 'c', 'd'].map((suffix) => `relay-4-${suffix}-${stamp}`);
    const sockets = await Promise.all(keys.map(async (key) => connect(withPowCookie(
      `csgofriberg_guest=${jwt.sign({ key, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' })}`
    ))));
    const [a, b, c, d] = sockets;
    const socketByPlayerKey = new Map(keys.map((key, index) => [`g:${key}`, sockets[index]]));
    try {
      expect(await emit(a, 'room:create', {
        dbType: 'easy', gameMode: 'relay', totalRounds: 1, maxPlayers: 5,
      })).toEqual({ code: 'VALIDATION_FAILED' });
      const created = await emit(a, 'room:create', {
        dbType: 'easy', gameMode: 'relay', totalRounds: 1, maxPlayers: 4,
        maxGuesses: 5, guessIntervalMs: 0,
      });
      createdRoomIds.push(created.room.id);
      expect(created.room).toMatchObject({
        gameMode: 'relay', totalRounds: 1, maxPlayers: 4, relaySolvedRounds: 0,
      });
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(c, 'room:join', { roomId: created.room.id });
      await emit(d, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(c, 'room:ready', { ready: true });
      await emit(d, 'room:ready', { ready: true });
      expect((await emit(a, 'game:start')).ok).toBe(true);
      const active = await getRoom(created.room.id);
      expect(active?.players).toHaveLength(4);
      expect(active?.currentTurnKey).toMatch(/^g:relay-4-[abcd]-/);
      const turnOrder = active!.players.map((player) => player.key).sort();
      const firstTurnKey = active!.currentTurnKey!;
      const firstTurnIndex = turnOrder.indexOf(firstTurnKey);
      const wrongGuesses = getDifficultyPlayers('easy')
        .filter((player) => player.id !== active!.targetPlayerId)
        .slice(0, 4);
      expect(wrongGuesses).toHaveLength(4);

      expect(await emit(socketByPlayerKey.get(firstTurnKey)!, 'room:state-probe')).toMatchObject({
        roomId: created.room.id,
        roundId: active!.round,
        stateVersion: active!.revision,
        status: 'playing',
        gameMode: 'relay',
        currentTurnKey: firstTurnKey,
      });
      let lastProbe: any;
      for (let attempt = 0; attempt < 12; attempt += 1) {
        lastProbe = await emit(socketByPlayerKey.get(firstTurnKey)!, 'room:state-probe');
      }
      expect(lastProbe).toEqual({ code: 'RATE_LIMITED' });

      const secondTurnKey = turnOrder[(firstTurnIndex + 1) % turnOrder.length];
      expect((await emit(socketByPlayerKey.get(secondTurnKey)!, 'game:guess', {
        playerId: wrongGuesses[0].id,
        roundId: active!.round,
        eventId: `relay-wrong-turn-${stamp}`,
      })).code).toBe('NOT_YOUR_TURN');
      expect(await emit(socketByPlayerKey.get(firstTurnKey)!, 'game:skip-round', { roundId: active!.round }))
        .toEqual({ code: 'RELAY_SKIP_DISABLED' });

      for (let guessIndex = 0; guessIndex < wrongGuesses.length; guessIndex += 1) {
        const actorKey = turnOrder[(firstTurnIndex + guessIndex) % turnOrder.length];
        const nextTurnKey = turnOrder[(firstTurnIndex + guessIndex + 1) % turnOrder.length];
        const appliedEvents = sockets.map((socket) => onceEvent(socket, 'game:guess:applied'));
        expect((await emit(socketByPlayerKey.get(actorKey)!, 'game:guess', {
          playerId: wrongGuesses[guessIndex].id,
          roundId: active!.round,
          eventId: `relay-rotate-${guessIndex}-${stamp}`,
        })).code).toBeUndefined();
        for (const applied of await Promise.all(appliedEvents)) {
          expect(applied).not.toHaveProperty('room');
          expect(applied).toMatchObject({
            key: actorKey,
            feedback: {
              playerId: wrongGuesses[guessIndex].id,
              nickname: wrongGuesses[guessIndex].nickname,
            },
            currentTurnKey: nextTurnKey,
            guessedAt: expect.any(Number),
          });
          expect(applied.feedback.attributes).not.toHaveProperty('region');
        }
        expect((await getRoom(created.room.id))?.currentTurnKey).toBe(nextTurnKey);
      }

      expect(await emit(socketByPlayerKey.get(secondTurnKey)!, 'room:state-probe')).toMatchObject({
        roomId: created.room.id,
        roundId: active!.round,
        status: 'playing',
        gameMode: 'relay',
        currentTurnKey: firstTurnKey,
      });
      expect((await emit(socketByPlayerKey.get(firstTurnKey)!, 'game:guess', {
        playerId: wrongGuesses[0].id,
        roundId: active!.round,
        eventId: `relay-duplicate-${stamp}`,
      })).code).toBe('ALREADY_GUESSED');
      const matchOver = onceEvent(a, 'match:over');
      expect((await emit(socketByPlayerKey.get(firstTurnKey)!, 'game:guess', {
        playerId: active!.targetPlayerId, roundId: active!.round, eventId: `relay-solve-${stamp}`,
      })).code).toBeUndefined();
      const finished = (await matchOver).room;
      expect(finished).toMatchObject({ gameMode: 'relay', relaySolvedRounds: 1 });
      expect(finished.matchResult).toMatchObject({ winnerKey: null, reason: 'cooperative_score' });
      expect(finished.relayGuesses.map((guess: any) => guess.actorKey)).toEqual([
        ...Array.from({ length: 4 }, (_, index) => turnOrder[(firstTurnIndex + index) % turnOrder.length]),
        firstTurnKey,
      ]);
    } finally {
      sockets.forEach((socket) => socket.disconnect());
    }
  });

  it('aborts an active relay room without persistence when a player leaves', async () => {
    const stamp = Date.now();
    const tokenA = jwt.sign({ key: `relay-leave-a-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: `relay-leave-b-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    try {
      const created = await emit(a, 'room:create', {
        dbType: 'easy', gameMode: 'relay', totalRounds: 3, maxGuesses: 8, guessIntervalMs: 0,
      });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      expect((await emit(a, 'game:start')).ok).toBe(true);
      const stored = await getRoom(created.room.id);
      const aborted = onceEvent(a, 'relay:aborted');

      expect(await emit(b, 'room:leave')).toEqual({ ok: true });
      expect(await aborted).toMatchObject({
        roomId: created.room.id,
        reason: 'player_left',
        playerKey: `g:relay-leave-b-${stamp}`,
        serverNow: expect.any(Number),
      });
      expect(await getRoom(created.room.id)).toBeNull();
      expect(await db('match_records').where({ room_id: stored!.recordId }).first()).toBeUndefined();
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('validates and applies custom room guess limits, intervals, and round duration', async () => {
    const stamp = Date.now();
    const tokenA = jwt.sign({ key: `custom-a-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const tokenB = jwt.sign({ key: `custom-b-${stamp}`, typ: 'guest' }, config.jwtSecret, { expiresIn: '1h' });
    const a = await connect(withPowCookie(`csgofriberg_guest=${tokenA}`));
    const b = await connect(withPowCookie(`csgofriberg_guest=${tokenB}`));
    try {
      expect(await emit(a, 'room:create', {
        dbType: 'easy', boType: 1, maxGuesses: 1, guessIntervalMs: 1_500,
      })).toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(a, 'room:create', {
        dbType: 'easy', boType: 1, maxGuesses: 8, guessIntervalMs: 10_001,
      })).toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(a, 'room:create', {
        dbType: 'easy', boType: 1, roundDurationMs: 9_999,
      })).toEqual({ code: 'VALIDATION_FAILED' });
      expect(await emit(a, 'room:create', {
        dbType: 'easy', boType: 1, roundDurationMs: 600_001,
      })).toEqual({ code: 'VALIDATION_FAILED' });

      const upperBoundary = await emit(a, 'room:create', {
        dbType: 'easy', boType: 1, roundDurationMs: 600_000,
      });
      createdRoomIds.push(upperBoundary.room.id);
      expect(upperBoundary.room.roundDurationMs).toBe(600_000);
      expect(await emit(a, 'room:leave')).toEqual({ ok: true });

      const created = await emit(a, 'room:create', {
        dbType: 'easy',
        boType: 1,
        maxGuesses: 2,
        guessIntervalMs: 0,
        roundDurationMs: 10_000,
      });
      createdRoomIds.push(created.room.id);
      expect(created.room).toMatchObject({
        maxGuesses: 2,
        guessIntervalMs: 0,
        roundDurationMs: 10_000,
      });
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready');
      const beforeStart = Date.now();
      expect((await emit(a, 'game:start')).ok).toBe(true);

      const active = await getRoom(created.room.id);
      expect(active?.roundEndsAt).toBeGreaterThanOrEqual(beforeStart + 9_000);
      expect(active?.roundEndsAt).toBeLessThanOrEqual(Date.now() + 10_000);
      const wrongGuesses = await db('players')
        .whereNot({ id: active!.targetPlayerId })
        .where({ is_enabled: true })
        .select('id')
        .limit(2);
      expect(wrongGuesses).toHaveLength(2);
      expect(await emit(a, 'game:guess', {
        playerId: wrongGuesses[0].id,
        roundId: active!.round,
        eventId: `custom-${stamp}-0001`,
      })).toEqual({ cooldownMs: 0 });
      expect(await emit(a, 'game:guess', {
        playerId: wrongGuesses[1].id,
        roundId: active!.round,
        eventId: `custom-${stamp}-0002`,
      })).toEqual({ cooldownMs: 0 });
      expect(await emit(a, 'game:guess', {
        playerId: wrongGuesses[0].id,
        roundId: active!.round,
        eventId: `custom-${stamp}-0003`,
      })).toEqual({ code: 'GUESS_LIMIT_REACHED' });
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('turns an accepted matchmaking rematch into a created room and waits for guest readiness', async () => {
    const userA = await createVerifiedUser();
    const userB = await createVerifiedUser();
    const a = await connect(userA.cookie);
    const b = await connect(userB.cookie);
    try {
      expect(await emit(a, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: true });
      const foundA = onceEvent(a, 'match:found');
      const foundB = onceEvent(b, 'match:found');
      expect(await emit(b, 'match:start', { dbType: 'easy', anonymous: true }))
        .toEqual({ queued: false });
      const [matchedA] = await Promise.all([foundA, foundB]);
      createdRoomIds.push(matchedA.room.id);
      expect(matchedA.room.rematchAllowed).toBe(true);
      expect(matchedA.room).toMatchObject({
        maxGuesses: 8,
        guessIntervalMs: 1_500,
        roundDurationMs: 120_000,
      });

      const roundA = onceEvent(a, 'round:start');
      const roundB = onceEvent(b, 'round:start');
      expect(await emit(a, 'room:ready', { ready: true })).toEqual({ ok: true });
      expect(await emit(b, 'room:ready', { ready: true })).toEqual({ ok: true });
      await Promise.all([roundA, roundB]);

      await withRoomLock(matchedA.room.id, (room) => {
        room.players.find((player) => player.key === userA.key)!.score = 1;
        return { room };
      });
      const active = await getRoom(matchedA.room.id);
      const originalRecordId = active!.recordId;
      const matchOver = onceEvent(a, 'match:over');
      await emit(a, 'game:guess', {
        playerId: active!.targetPlayerId,
        roundId: active!.round,
        eventId: `matchmaking-rematch-finish-${Date.now()}`,
      });
      await matchOver;

      const wantedEvent = onceEvent(b, 'match:rematch:update');
      expect(await emit(a, 'match:rematch-want', { wanted: true }))
        .toEqual({ ok: true, stateVersion: expect.any(Number) });
      expect(await wantedEvent).toMatchObject({
        roomId: matchedA.room.id,
        outcome: 'wanted',
        actorKey: userA.key,
      });

      const startedEvent = onceEvent(a, 'match:rematch:update');
      const rematchRoundA = onceEvent(a, 'round:start');
      const rematchRoundB = onceEvent(b, 'round:start');
      expect(await emit(b, 'match:rematch-want', { wanted: true }))
        .toEqual({ ok: true, stateVersion: expect.any(Number) });
      expect(await startedEvent).toMatchObject({
        roomId: matchedA.room.id,
        outcome: 'started',
        actorKey: userB.key,
      });
      await Promise.all([rematchRoundA, rematchRoundB]);

      const rematchRoom = await getRoom(matchedA.room.id);
      expect(rematchRoom).toMatchObject({
        status: 'playing',
        matchmaking: false,
        readyCheckEndsAt: null,
        rematchAllowed: true,
        maxGuesses: 8,
        guessIntervalMs: 1_500,
      });
      expect(rematchRoom?.recordId).not.toBe(originalRecordId);
      expect(rematchRoom?.players.map((player) => ({
        key: player.key,
        ready: player.ready,
        score: player.score,
      }))).toEqual([
        { key: userA.key, ready: true, score: 0 },
        { key: userB.key, ready: true, score: 0 },
      ]);
      expect(await emit(a, 'match:report', { description: 'after rematch' }))
        .toEqual({ code: 'REPORT_NOT_AVAILABLE' });
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
      expect(matchOver.room.matchReplay).toMatchObject({
        mode: 'easy',
        boType: 1,
        rounds: [{ round: 1 }],
      });
      const spectatorFinished = await emit(spectator, 'room:sync');
      expect(spectatorFinished.room).not.toHaveProperty('matchReplay');
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

      const roundOverPromise = onceEvent(b, 'round:over');
      await emit(b, 'game:guess', {
        playerId: stored.targetPlayerId,
        roundId: syncedA.room.roundId,
        eventId: `hidden-${stamp}-0002`,
      });
      const roundOver = await roundOverPromise;
      expect(roundOver.room.status).toBe('round_over');
      const revealedOpponent = roundOver.room.players.find(
        (player: any) => player.key === `g:${keyA}`
      );
      expect(revealedOpponent.guesses[0].playerId).toBe(wrongGuess.id);
      expect(revealedOpponent.guesses[0].nickname).toEqual(expect.any(String));
      expect(revealedOpponent.guesses[0].attributes.nationality).toHaveProperty('value');
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
        .where({ is_enabled: true })
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
      const roomAfterFirst = await getRoom(created.room.id);
      const playerAfterFirst = roomAfterFirst!.players.find((player) => player.key === identityA)!;
      expect(playerAfterFirst.guesses).toHaveLength(1);
      expect(playerAfterFirst.guessTimes).toHaveLength(1);
      expect(playerAfterFirst.guessTimes[0]).toBeGreaterThanOrEqual(0);
      expect(playerAfterFirst.guessTimes[0]).toBeLessThanOrEqual(120_000);
      expect(synced.room.players.find((player: any) => player.key === identityA))
        .not.toHaveProperty('guessTimes');
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
      expect(coolingDown.retryAfterMs).toBeLessThanOrEqual(1_500);
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
      const roomAfterSecond = await getRoom(created.room.id);
      const timesAfterSecond = roomAfterSecond!.players.find(
        (player) => player.key === identityA
      )!.guessTimes;
      expect(timesAfterSecond).toHaveLength(2);
      expect(timesAfterSecond[1]!).toBeGreaterThan(timesAfterSecond[0]!);

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
    const { config } = await import('../../src/config');
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
    const { config } = await import('../../src/config');
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
      const created = await emit(a, 'room:create', { dbType: 'easy', boType: 3 });
      createdRoomIds.push(created.room.id);
      await emit(b, 'room:join', { roomId: created.room.id });
      await emit(b, 'room:ready', { ready: true });
      await emit(a, 'game:start');
      const stored = JSON.parse((await redis()!.get(redisKey(`room:${created.room.id}`)))!);
      await withRoomLock(created.room.id, (room) => {
        const winner = room.players.find((player) => player.key === `g:${keyA}`)!;
        winner.score = 1;
        room.round = 2;
        room.replayRounds = [{
          round: 1,
          targetPlayerId: room.targetPlayerId!,
          winnerKey: winner.key,
          reason: 'guessed',
          guessesByPlayer: {
            [`g:${keyA}`]: [room.targetPlayerId!],
            [`g:${keyB}`]: [],
          },
        }];
        for (const player of room.players) {
          player.guesses = [];
          player.lastGuessAt = null;
        }
        return { room };
      });
      const before = await emit(a, 'room:sync');
      expect(before.room).not.toHaveProperty('matchReplay');
      const matchOverPromise = onceEvent(a, 'match:over');
      const opponentMatchOverPromise = onceEvent(b, 'match:over');
      const guessed = await emit(a, 'game:guess', {
        playerId: stored.targetPlayerId,
        roundId: before.room.roundId,
        eventId: `result-${stamp}-0001`,
      });
      const matchOver = await matchOverPromise;
      const opponentMatchOver = await opponentMatchOverPromise;
      expect(guessed.room).toBeUndefined();
      expect(matchOver.room.status).toBe('finished');
      expect(matchOver.room.matchReplay).toMatchObject({
        id: expect.any(String),
        mode: 'easy',
        boType: 3,
        result: 'won',
        me: { score: 2 },
        opponent: { score: 0 },
      });
      expect(matchOver.room.matchReplay.rounds).toHaveLength(2);
      expect(matchOver.room.matchReplay.rounds.map((round: any) => ({
        round: round.round,
        winner: round.winner,
        myGuesses: round.me.guesses.length,
        opponentGuesses: round.opponent.guesses.length,
      }))).toEqual([
        { round: 1, winner: 'me', myGuesses: 1, opponentGuesses: 0 },
        { round: 2, winner: 'me', myGuesses: 1, opponentGuesses: 0 },
      ]);
      expect(opponentMatchOver.room.matchReplay).toMatchObject({
        result: 'lost',
        me: { score: 0 },
        opponent: { score: 2 },
      });
      expect(opponentMatchOver.room.matchReplay.rounds.map((round: any) => ({
        winner: round.winner,
        myGuesses: round.me.guesses.length,
        opponentGuesses: round.opponent.guesses.length,
      }))).toEqual([
        { winner: 'opponent', myGuesses: 0, opponentGuesses: 1 },
        { winner: 'opponent', myGuesses: 0, opponentGuesses: 1 },
      ]);
      const restored = await emit(a, 'room:sync');
      expect(restored.room.matchResult).toMatchObject({
        winnerKey: `g:${keyA}`,
        reason: 'score',
      });
      expect(restored.room.roundResult).toBeNull();
      expect(restored.room.matchReplay.rounds).toHaveLength(2);
      const storedFinished = await getRoom(created.room.id);
      expect(storedFinished?.replayRounds[0].guessTimesByPlayer[`g:${keyA}`]).toEqual([null]);
      const finalGuessTimes = storedFinished?.replayRounds[1]
        .guessTimesByPlayer[`g:${keyA}`];
      expect(finalGuessTimes).toHaveLength(1);
      expect(finalGuessTimes?.[0]).toBeGreaterThanOrEqual(0);
      expect(finalGuessTimes?.[0]).toBeLessThanOrEqual(120_000);
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

  it('shows a single-player skip to both players without awarding a score', async () => {
    const stamp = Date.now();
    const keyA = `skip-a-${stamp}`;
    const keyB = `skip-b-${stamp}`;
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
      const patchPromise = onceEvent(b, 'room:patch');
      const skipped = await emit(a, 'game:skip-round', { roundId: active.room.roundId });
      const patch = await patchPromise;
      expect(skipped).toMatchObject({ ok: true, room: { status: 'playing' } });
      expect(patch.players.updated).toEqual([{ key: `g:${keyA}`, skipped: true }]);

      const synced = await emit(b, 'room:sync');
      expect(synced.room.status).toBe('playing');
      expect(synced.room.players.find((player: any) => player.key === `g:${keyA}`)).toMatchObject({
        skipped: true,
        score: 0,
      });
      expect(synced.room.players.find((player: any) => player.key === `g:${keyB}`).score).toBe(0);
      const guessPlayer = getDifficultyPlayers('easy')[0];
      expect((await emit(a, 'game:guess', {
        playerId: guessPlayer.id,
        roundId: active.room.roundId,
        eventId: `skip-${stamp}-0001`,
      })).code).toBe('ROUND_SKIPPED');
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('clears a skipped player room mapping after leaving the match', async () => {
    const stamp = Date.now();
    const keyA = `skip-leave-a-${stamp}`;
    const keyB = `skip-leave-b-${stamp}`;
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

      expect((await emit(a, 'game:skip-round', { roundId: active.room.roundId })).ok).toBe(true);
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

  it('reveals the answer and records a draw after both players skip', async () => {
    const stamp = Date.now();
    const keyA = `skip-both-a-${stamp}`;
    const keyB = `skip-both-b-${stamp}`;
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
      expect((await emit(a, 'game:skip-round', { roundId: active.room.roundId })).ok).toBe(true);
      const roundOverPromise = onceEvent(a, 'round:over');
      expect((await emit(b, 'game:skip-round', { roundId: active.room.roundId })).ok).toBe(true);
      const roundOver = await roundOverPromise;
      expect(roundOver.room.roundResult).toMatchObject({
        winnerKey: null,
        reason: 'skipped',
        answer: { nickname: expect.any(String) },
      });
      const synced = await emit(b, 'room:sync');
      expect(synced.room.status).toBe('round_over');
      expect(synced.room.matchResult).toBeNull();
      expect(synced.room.players.map((player: any) => player.score)).toEqual([0, 0]);
    } finally {
      a.disconnect();
      b.disconnect();
    }
  });

  it('records a draw when one player skips and the other uses every guess', async () => {
    const stamp = Date.now();
    const keyA = `skip-limit-a-${stamp}`;
    const keyB = `skip-limit-b-${stamp}`;
    const identityB = `g:${keyB}`;
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
      expect((await emit(a, 'game:skip-round', { roundId: active.room.roundId })).ok).toBe(true);

      const stored = await getRoom(created.room.id);
      const target = getPlayer(stored!.targetPlayerId!)!;
      const wrongPool = getDifficultyPlayers('easy')
        .filter((player) => player.id !== target.id)
      expect(wrongPool.length).toBeGreaterThan(1);
      const finalWrong = wrongPool[wrongPool.length - 1];
      const wrongPlayers = Array.from({ length: 8 }, (_, index) => (
        index === 7 ? finalWrong : wrongPool[index % (wrongPool.length - 1)]
      ));
      expect(wrongPlayers).toHaveLength(8);
      await withRoomLock(created.room.id, (locked) => {
        const player = locked.players.find((candidate) => candidate.key === identityB)!;
        player.guesses = wrongPlayers.slice(0, 7).map((guess) => compareGuess(guess, target));
        player.guessTimes = player.guesses.map(() => null);
        player.lastGuessAt = null;
      });

      const roundOverPromise = onceEvent(a, 'round:over');
      expect((await emit(b, 'game:guess', {
        playerId: wrongPlayers[7].id,
        roundId: active.room.roundId,
        eventId: `skip-limit-${stamp}-0001`,
      }))).toMatchObject({ cooldownMs: expect.any(Number) });
      const roundOver = await roundOverPromise;
      expect(roundOver.room.roundResult).toMatchObject({
        winnerKey: null,
        reason: 'skipped',
        answer: { nickname: target.nickname },
      });
      expect(roundOver.room.players.map((player: any) => player.score)).toEqual([0, 0]);
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
