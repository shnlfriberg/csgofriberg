import { describe, expect, it } from 'vitest';
import { assertGuess, calibrationValid, dayWindow, MIX, sample, score } from '../../src/location/rules';
import { gameView } from '../../src/location/games';
import { advanceRoom, answerRoom, roomView } from '../../src/location/rooms';
import type { GameState } from '../../src/location/types';
import { testMap, testPool, testRoom } from './fixtures';

describe('location rules and private views', () => {
  it.each(['easy', 'normal', 'hard'] as const)('draws exactly the %s mix without repeating points', difficulty => {
    const pool = testPool(); pool[1].question.capturePointId = pool[0].question.capturePointId;
    pool[2].map = { ...pool[2].map, enabled: false };
    const excluded = new Set(['test_location_3', 'point:test_location:point_4']);
    for (let i = 0; i < 20; i++) {
      const deck = sample(pool, difficulty, excluded);
      expect(deck).toHaveLength(5);
      expect(Object.fromEntries(['easy', 'medium', 'hard'].map(t => [t, deck.filter(q => q.question.tier === t).length]))).toEqual(MIX[difficulty]);
      expect(new Set(deck.map(q => q.question.capturePointId)).size).toBe(5);
      expect(deck.every(q => q.map.enabled && !excluded.has(q.question.id) && q.question.capturePointId !== 'point_4')).toBe(true);
    }
  });
  it('rejects insufficient unique capture points even across tiers', () => {
    const pool = testPool(6); pool.forEach(q => q.question.capturePointId = 'same');
    expect(() => sample(pool, 'normal')).toThrow('LOCATION_POOL_INSUFFICIENT');
  });
  it('uses intrinsic rectangular dimensions, tolerance and rounded floor penalty', () => {
    const snapshot = testPool()[0]; const map = snapshot.map;
    for (const [ratio, expected, wrongFloor] of [[.005, 5000, 1250], [.05, 3993, 998], [.1, 3109, 777], [.25, 1469, 367]]) {
      const guess = { ...snapshot.question, u: snapshot.question.u + ratio * Math.hypot(map.width, map.height) / map.width };
      expect(score(snapshot, guess, [map], 1).score).toBe(expected);
      expect(score(snapshot, { ...guess, floorId: 'lower' }, [map], 1).score).toBe(wrongFloor);
    }
    expect(score(snapshot, { ...snapshot.question, mapId: 'wrong' }, [map], 1)).toMatchObject({ score: 0, distanceRatio: null });
    expect(score(snapshot, null, [map], 1).score).toBe(0);
    map.bounds.width = map.bounds.height = .001;
    expect(score(snapshot, { ...snapshot.question, u: 1, v: 1 }, [map], 1).score).toBe(1);
  });
  it('validates guesses and per-floor measured calibration', () => {
    const map = testMap(); expect(calibrationValid(map)).toBe(true);
    expect(() => assertGuess({ mapId: map.id, floorId: 'lower', u: NaN, v: 0 }, [map])).toThrow();
    map.calibration.points[0].x += 100; expect(calibrationValid(map)).toBe(false);
    map.calibration.points = []; expect(calibrationValid(map)).toBe(false);
  });
  it('rolls days at Shanghai midnight', () => {
    expect(dayWindow(Date.parse('2026-10-04T15:59:59Z')).date).toBe('2026-10-04');
    const next = dayWindow(Date.parse('2026-10-04T16:00:00Z')); expect(next.date).toBe('2026-10-05'); expect(next.nextRefreshAt - next.startsAt).toBe(86400000);
  });
  it('reveals no results in daily ready state', () => {
    const questions = testPool().slice(0, 5);
    const game: GameState = { id: 'private', owner: { key: 'g:a', userId: null, name: 'a' }, mode: 'daily', difficulty: 'normal', date: '2026-10-05', status: 'ready', questions, maps: [testMap()], guesses: questions.map(q => ({ mapId: q.map.id, floorId: q.question.floorId, u: q.question.u, v: q.question.v })), requests: {}, scoringVersion: 1, version: 5, createdAt: 0, updatedAt: 0, expiresAt: Infinity };
    const view = gameView(game); expect(view.results).toEqual([]); expect(view.totalScore).toBeNull(); expect(view.question).toBeNull(); expect(view).not.toHaveProperty('questions');
    game.status = 'finished'; expect(gameView(game).totalScore).toBe(25000);
  });
  it('locks a submitted guess until unified reveal, handles ties and retirement', async () => {
    const room = testRoom(); const input = { ...room.questions[0].question, round: 1, version: 1, requestId: 'fixed' };
    await answerRoom(room, room.players[0].identity, input); await answerRoom(room, room.players[0].identity, input);
    expect(roomView(room, 'g:b').myGuess).toBeNull(); expect(roomView(room, 'g:b').results.every(p => p.rounds.length === 0)).toBe(true);
    expect(await advanceRoom(room)).toBe(false);
    await answerRoom(room, room.players[1].identity, input); expect(await advanceRoom(room)).toBe(true);
    expect(room.status).toBe('round_over'); expect(roomView(room, 'g:a').results[1].rounds[0].score).toBe(5000);
    room.round = 5; room.status = 'playing'; room.endsAt = Date.now() - 1; room.players.forEach(p => { p.guesses = Array(4).fill(p.currentGuess); });
    await advanceRoom(room); expect(roomView(room, 'g:a').players.map(p => p.rank)).toEqual([1, 1]);
    const disconnected = testRoom(); disconnected.players[1].connected = false; disconnected.players[1].disconnectAt = Date.now() - 1; disconnected.players[0].currentGuess = input;
    await advanceRoom(disconnected); expect(disconnected.players[1].retired).toBe(true); expect(disconnected.players[1].guesses).toEqual([null]); expect(disconnected.status).toBe('round_over');
    disconnected.players[0].retired = true; await advanceRoom(disconnected); expect(disconnected.status).toBe('cancelled');
  });
});
