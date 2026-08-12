import { describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'crypto';
import {
  applyRoomGuess,
  StoredRoom,
  deleteRoom,
  getRoom,
  getRoomForIdentity,
  removeExpiredSpectators,
  saveRoom,
  withRoomLock,
} from '../../src/services/roomStore';

function makeRoom(id: string): StoredRoom {
  const now = Date.now();
  return {
    id,
    recordId: randomUUID(),
    ownerIp: '127.0.0.1',
    hostKey: 'u:1',
    status: 'waiting',
    matchmaking: false,
    readyCheckEndsAt: null,
    dbType: 'normal',
    boType: 3,
    gameMode: 'classic',
    totalRounds: 3,
    maxPlayers: 2,
    currentTurnKey: null,
    relaySolvedRounds: 0,
    relayGuesses: [],
    maxGuesses: 8,
    guessIntervalMs: 1_500,
    rematchAllowed: true,
    rematchInviterKey: null,
    rematchAcceptedKeys: [],
    rematchRequiredKeys: [],
    allowSpectators: false,
    verifiedOnly: false,
    anonymous: false,
    round: 0,
    players: [{
      key: 'u:1', userId: 1, name: 'one', socketId: 's1', ready: true,
      score: 0, guesses: [], lastGuessAt: null, connected: true, disconnectDeadline: null,
      guessTimes: [], skipped: false, eliminated: false, eliminationReason: null,
    }],
    spectators: [],
    targetPlayerId: null,
    roundEndsAt: null,
    nextRoundAt: null,
    eventResults: {},
    roundResult: null,
    matchResult: null,
    replayRounds: [],
    reports: [],
    revision: 0,
    createdAt: now,
    updatedAt: now,
  };
}

describe('roomStore local fallback', () => {
  it('backfills defaults for rooms created before custom settings existed', async () => {
    const room = makeRoom(`LEGACY${Date.now()}`);
    const legacy = room as unknown as Record<string, unknown>;
    delete legacy.maxGuesses;
    delete legacy.guessIntervalMs;
    await saveRoom(room);
    const stored = await getRoom(room.id);
    expect(stored).toMatchObject({ maxGuesses: 8, guessIntervalMs: 1_500 });
    if (stored) await deleteRoom(stored);
  });

  it('serializes concurrent room updates and indexes identities', async () => {
    const room = makeRoom(`T${Date.now()}`);
    await saveRoom(room);
    await Promise.all(Array.from({ length: 20 }, () =>
      withRoomLock(room.id, (locked) => {
        locked.players[0].score += 1;
      })
    ));
    const found = await getRoomForIdentity('u:1');
    expect(found?.players[0].score).toBe(20);
    if (found) await deleteRoom(found);
  });

  it('does not clear a newer identity mapping when an old room is deleted', async () => {
    const oldRoom = makeRoom(`OLD${Date.now()}`);
    oldRoom.status = 'finished';
    oldRoom.matchResult = { winnerKey: 'u:1', reason: 'test', forfeitedKey: null };
    const newRoom = makeRoom(`NEW${Date.now()}`);
    await saveRoom(oldRoom);
    await saveRoom(newRoom);
    await deleteRoom(oldRoom);
    expect((await getRoomForIdentity('u:1'))?.id).toBe(newRoom.id);
    await deleteRoom(newRoom);
  });

  it('does not let a delayed old-room save reclaim an identity from a new room', async () => {
    const oldRoom = makeRoom(`LATE${Date.now()}`);
    oldRoom.status = 'finished';
    oldRoom.matchResult = { winnerKey: 'u:1', reason: 'test', forfeitedKey: null };
    const newRoom = makeRoom(`CURRENT${Date.now()}`);
    await saveRoom(oldRoom);
    await saveRoom(newRoom);

    await withRoomLock(oldRoom.id, (locked) => {
      locked.players[0].connected = false;
      locked.players[0].disconnectDeadline = Date.now() + 1000;
    });

    expect((await getRoomForIdentity('u:1'))?.id).toBe(newRoom.id);
    const delayedOldRoom = await import('../../src/services/roomStore').then(({ getRoom }) => getRoom(oldRoom.id));
    if (delayedOldRoom) await deleteRoom(delayedOldRoom);
    await deleteRoom(newRoom);
  });

  it('rejects creating a second active room for the same identity', async () => {
    const first = makeRoom(`FIRST${Date.now()}`);
    const second = makeRoom(`SECOND${Date.now()}`);
    await saveRoom(first);
    await expect(saveRoom(second)).rejects.toThrow('ROOM_IDENTITY_CONFLICT');
    expect((await getRoomForIdentity('u:1'))?.id).toBe(first.id);
    await deleteRoom(first);
  });

  it('rejects an older room snapshot after a newer revision is stored', async () => {
    const room = makeRoom(`REV${Date.now()}`);
    await saveRoom(room);
    const stale = structuredClone(room);
    await withRoomLock(room.id, (locked) => {
      locked.players[0].score = 2;
    });
    await expect(saveRoom(stale)).rejects.toThrow('STALE_ROOM_WRITE');
    expect((await getRoomForIdentity('u:1'))?.players[0].score).toBe(2);
    const current = await getRoomForIdentity('u:1');
    if (current) await deleteRoom(current);
  });

  it('removes multiple expired spectators in one room update', async () => {
    const room = makeRoom(`SPECTATORS${Date.now()}`);
    const now = Date.now();
    room.allowSpectators = true;
    room.spectators = [
      {
        key: 'g:s1', userId: null, name: 's1', socketId: 'socket-s1',
        connected: false, disconnectDeadline: now - 1,
      },
      {
        key: 'g:s2', userId: null, name: 's2', socketId: 'socket-s2',
        connected: false, disconnectDeadline: now - 1,
      },
      {
        key: 'g:s3', userId: null, name: 's3', socketId: 'socket-s3',
        connected: true, disconnectDeadline: null,
      },
    ];
    await saveRoom(room);

    const result = await removeExpiredSpectators(room.id, ['g:s1', 'g:s2'], now);
    expect(result?.removedKeys).toEqual(['g:s1', 'g:s2']);
    expect((await getRoomForIdentity('u:1'))?.spectators.map((spectator) => spectator.key))
      .toEqual(['g:s3']);

    const current = await import('../../src/services/roomStore').then(({ getRoom }) => getRoom(room.id));
    if (current) await deleteRoom(current);
  });

  it('records a bounded relative guess time in the room state', async () => {
    const room = makeRoom(`TIMES${Date.now()}`);
    room.status = 'playing';
    room.round = 1;
    room.targetPlayerId = 7;
    room.roundEndsAt = 130_000;
    vi.setSystemTime(12_500);
    try {
      await saveRoom(room);
      const result = await applyRoomGuess({
        roomId: room.id,
        identity: 'u:1',
        socketId: 's1',
        expectedRound: 1,
        eventId: 'event-1',
        targetPlayerId: 7,
        feedback: { playerId: 2, correct: false } as any,
        maxGuesses: 10,
        roundDurationMs: 120_000,
        nextRoundDelayMs: 100,
        minGuessIntervalMs: 1_500,
        rateLimit: 12,
        rateWindowSeconds: 10,
      });
      expect(result.kind).toBe('applied');
      const stored = await getRoom(room.id);
      expect(stored?.players[0].guessTimes).toEqual([2_500]);
      if (stored) await deleteRoom(stored);
    } finally {
      vi.useRealTimers();
    }
  });
});
