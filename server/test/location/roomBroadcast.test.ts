import { describe, expect, it, vi } from 'vitest';
import { broadcast } from '../../src/location/roomBroadcast';
import { roomView } from '../../src/location/roomView';
import type { RoomState } from '../../src/location/types';
import { testPool } from './fixtures';

describe('personalized room deltas', () => {
  it('sends a full baseline, then only changes, and keeps other seats guesses private', async () => {
    const snapshot = testPool()[0];
    const players = Array.from({ length: 8 }, (_, i) => ({ identity: { key: `g:${i}`, userId: null, name: `Seat ${i}` },
      socketId: `socket-${i}`, ready: true, connected: true, disconnectAt: null, retired: false, guesses: [], currentGuess: null, requests: {} }));
    const room: RoomState = { id: 'DELTA', gameId: 'delta-test', host: players[0].identity.key, difficulty: 'easy', duration: 60, status: 'playing',
      players, maps: [snapshot.map], questions: [snapshot], round: 1, startsAt: null, endsAt: 10000, nextAt: null, createdAt: 0, revision: 1 };
    const sockets = new Map(players.map(p => [p.socketId, { data: { locationDelta: true }, emit: vi.fn() }]));
    const sent = new Map<string, any>();
    const io = { sockets: { sockets }, to: (id: string) => ({ emit: (_event: string, view: any) => sent.set(id, view) }) };
    await broadcast(io as any, room);
    expect(sent.size).toBe(8);
    const baseline = sent.get('socket-0');
    room.players[0].currentGuess = { mapId: snapshot.map.id, floorId: snapshot.question.floorId, u: .12, v: .34 };
    room.revision++;
    await broadcast(io as any, room);
    const [event, patch] = sockets.get('socket-0')!.emit.mock.calls[0];
    expect(event).toBe('location:room:patch');
    expect(patch.baseRevision).toBe(1);
    expect(patch.changes).not.toHaveProperty('maps');
    expect(patch.changes).not.toHaveProperty('results');
    expect({ ...baseline, ...patch.changes }).toEqual(roomView(room, 'g:0', patch.changes.serverNow ?? baseline.serverNow));
    const other = sockets.get('socket-1')!.emit.mock.calls[0][1];
    expect(other.changes).not.toHaveProperty('myGuess');
    expect(JSON.stringify(other)).not.toContain('0.12');
    expect(other.changes.players[0].submitted).toBe(true);
  });
});
