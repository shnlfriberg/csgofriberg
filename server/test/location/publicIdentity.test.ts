import { expect, it } from 'vitest';
import { roomView } from '../../src/location/roomView';
import { publicReplay } from '../../src/location/publicIdentity';
import { testRoom } from './fixtures';
import type { ReplayRecord } from '../../src/location/types';

it('uses game-scoped player keys consistently for every recipient and hides raw guest identities', () => {
  const room = testRoom();
  room.players[1].identity = { key: 'u:42', userId: 42, name: 'Account' };
  const a = roomView(room, 'g:a'), b = roomView(room, 'u:42');
  expect(a.me).toBe(a.host); expect(a.viewerUserId).toBeNull(); expect(b.viewerUserId).toBe(42);
  expect(a.players).toEqual(b.players); expect(a.results[1].key).toBe(b.me);
  expect(a.players.map(p => p.key)).toContain(a.me);
  for (const view of [a, b]) {
    expect(JSON.stringify(view)).not.toContain('g:a'); expect(JSON.stringify(view)).not.toContain('u:42');
  }
  expect(roomView({ ...room, gameId: 'another-game' }, 'g:a').me).not.toBe(a.me);
});
it('sanitizes legacy multiplayer replay keys without changing saved snapshots or claimed seat selection', () => {
  const room = testRoom(), view = roomView(room, 'g:a');
  const legacy = { gameId: room.gameId, owner: { key: 'u:42', userId: 42, name: 'Claimed' }, mode: 'multiplayer',
    difficulty: 'normal', difficultyMix: { easy: 0, medium: 0, hard: 0 }, date: null, totalScore: 0,
    results: [], scoringVersion: 1, myKey: 'g:a',
    participants: view.players.map((p, i) => ({ ...p, key: room.players[i].identity.key })),
    roomResults: view.results.map((p, i) => ({ ...p, key: room.players[i].identity.key })),
  } as ReplayRecord;
  const before = JSON.stringify(legacy), result = publicReplay(legacy);
  expect(JSON.stringify(result)).not.toContain('g:a'); expect(JSON.stringify(result)).not.toContain('g:b');
  expect(result.myKey).toBe(view.me); expect(result.roomResults![0].key).toBe(result.myKey);
  expect(publicReplay(result)).toEqual(result); expect(JSON.stringify(legacy)).toBe(before);
});
