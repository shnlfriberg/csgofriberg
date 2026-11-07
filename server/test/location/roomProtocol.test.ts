import { describe, expect, it } from 'vitest';
import { emitRevision, v2View } from '../../src/location/roomProtocol';
import { advance, answer, newChanges } from '../../src/location/roomEngine';
import { roomView } from '../../src/location/roomView';
import type { CompactRoundResult, MapDefinition, RoomPatchSectionsV2, RoomState, RoomView, RoomViewV2, RoundResult } from '../../src/location/types';

// Reference merge used by the web client (client/src/location/roomProtocol.ts).
const hydrate = (round: CompactRoundResult, maps: MapDefinition[]): RoundResult => ({
  ...round,
  map: maps.find((map) => map.id === round.answer.mapId)!,
  guessedMap: round.guess ? maps.find((map) => map.id === round.guess!.mapId) ?? null : null,
});
function hydrateRoomView(view: RoomViewV2, maps: MapDefinition[]): RoomView {
  const { protocol: _p, mapsHash: _h, maps: _m, results, ...rest } = view;
  return { ...rest, maps, results: results.map((r) => ({ ...r, rounds: r.rounds.map((round) => hydrate(round, maps)) })) };
}
function applyRoomPatchV2(view: RoomView, sections: RoomPatchSectionsV2, rev: number, serverNow: number, maps: MapDefinition[]): RoomView {
  const next: RoomView = { ...view, revision: rev, serverNow };
  for (const key of ['status', 'round', 'startsAt', 'endsAt', 'nextAt', 'question', 'host', 'players'] as const)
    if (sections[key] !== undefined) (next as any)[key] = sections[key];
  if (sections.clearMyGuess) next.myGuess = null;
  if (sections.resultsAppend) next.results = view.results.map((r) => ({
    ...r, rounds: [...r.rounds, ...sections.resultsAppend!.filter((item) => item.key === r.key).map((item) => hydrate(item.round, maps))],
  }));
  return next;
}
import { testRoom } from './fixtures';

function recorder() {
  const sent: Array<{ channel: string; event: string; payload: any }> = [];
  const io = { to: (channel: string) => ({ emit: (event: string, payload: unknown) => sent.push({ channel, event, payload }) }) };
  return { io: io as any, sent };
}

function eightSeats(): RoomState {
  const room = testRoom();
  room.players = Array.from({ length: 8 }, (_, i) => ({ identity: { key: `g:${i}`, userId: null, name: `Seat ${i}` },
    socketId: `socket-${i}`, ready: true, connected: true, disconnectAt: null, retired: false, guesses: [], currentGuess: null, requests: {} }));
  room.host = 'g:0';
  return room;
}

describe('图寻 room protocol on the room kernel', () => {
  it('sends one public patch per revision and keeps guesses private before the reveal', () => {
    const room = eightSeats();
    const question = room.questions[0].question;
    const { io, sent } = recorder();
    const changes = newChanges();
    answer(room, 'g:0', { mapId: question.mapId, floorId: question.floorId, u: 0.12, v: 0.34, round: 1, version: 1, requestId: 'r1' }, Date.now(), changes);
    room.revision = 2;
    emitRevision(io, room, changes, 1);
    const publicPatches = sent.filter((item) => item.event === 'room-kernel:patch');
    expect(publicPatches).toHaveLength(1);
    expect(publicPatches[0].channel).toBe('location:room:TEST1');
    expect(publicPatches[0].payload).toMatchObject({ game: 'location', roomId: 'TEST1', base: 1, rev: 2 });
    expect(JSON.stringify(publicPatches[0].payload)).not.toContain('0.12');
    expect(publicPatches[0].payload.sections.players[0].submitted).toBe(true);
    expect(publicPatches[0].payload.sections).not.toHaveProperty('maps');
    expect(publicPatches[0].payload.sections).not.toHaveProperty('resultsAppend');
    const privatePatches = sent.filter((item) => item.event === 'room-kernel:private');
    expect(privatePatches).toEqual([expect.objectContaining({ channel: 'location:room:TEST1:seat:g:0' })]);
    expect(privatePatches[0].payload.private.myGuess).toMatchObject({ u: 0.12, v: 0.34 });
    // No protocol v1 seats: no per-seat full or legacy patches are published.
    expect(sent.filter((item) => item.event === 'location:room:patch')).toHaveLength(0);
  });

  it('reveals compact results that hydrate to exactly the original full view', () => {
    const room = eightSeats();
    const before = v2View(room, 'g:3');
    const baseline = hydrateRoomView(before, room.maps);
    expect(baseline).toEqual({ ...roomView(room, 'g:3', before.serverNow) });
    const question = room.questions[0].question;
    for (const [index, p] of room.players.entries()) {
      answer(room, p.identity.key, { mapId: question.mapId, floorId: question.floorId, u: question.u, v: question.v, round: 1, version: 1, requestId: `r${index}` }, Date.now(), newChanges());
    }
    const changes = newChanges();
    expect(advance(room, Date.now(), changes)).toBe(true);
    room.revision = 2;
    const { io, sent } = recorder();
    emitRevision(io, room, changes, 1);
    const patch = sent.find((item) => item.event === 'room-kernel:patch')!.payload;
    const sections = patch.sections as RoomPatchSectionsV2;
    expect(sections.resultsAppend).toHaveLength(8);
    expect(JSON.stringify(sections)).not.toContain('"calibration"');
    const merged = applyRoomPatchV2(baseline, sections, patch.rev, patch.serverNow, room.maps)!;
    const expected = roomView(room, 'g:3', patch.serverNow);
    expect({ ...merged, myGuess: expected.myGuess }).toEqual(expected);
  });

  it('keeps protocol v1 pages working with section-built top-level patches', () => {
    const room = eightSeats();
    room.v1Seats = ['g:1'];
    const baseline = roomView(room, 'g:1');
    const question = room.questions[0].question;
    const changes = newChanges();
    answer(room, 'g:0', { mapId: question.mapId, floorId: question.floorId, u: 0.12, v: 0.34, round: 1, version: 1, requestId: 'r1' }, Date.now(), changes);
    room.revision = 2;
    const { io, sent } = recorder();
    emitRevision(io, room, changes, 1);
    const legacy = sent.filter((item) => item.event === 'location:room:patch');
    expect(legacy).toHaveLength(1);
    expect(legacy[0].channel).toBe('location:room:TEST1:v1:g:1');
    expect(legacy[0].payload).toMatchObject({ id: 'TEST1', baseRevision: 1, revision: 2 });
    expect(legacy[0].payload.changes).not.toHaveProperty('myGuess');
    expect(legacy[0].payload.changes).not.toHaveProperty('maps');
    expect(JSON.stringify(legacy[0].payload)).not.toContain('0.12');
    expect({ ...baseline, ...legacy[0].payload.changes }).toEqual(roomView(room, 'g:1', legacy[0].payload.changes.serverNow));
  });

  it('omits the map catalogue from views when the client already holds it', () => {
    const room = eightSeats();
    room.mapsHash = 'cached-hash';
    expect(v2View(room, 'g:0')).toHaveProperty('maps');
    expect(v2View(room, 'g:0', { includeMaps: false })).not.toHaveProperty('maps');
  });
});
