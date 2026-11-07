import { createHash } from 'crypto';
import type { Server, Socket } from 'socket.io';
import { emitTo } from '../rooms/kernel/broadcast';
import { publicPlayerKey } from './publicIdentity';
import { roomView } from './roomView';
import type { RoomChanges } from './roomEngine';
import { compactRoundResult } from '@friberg/location-core';
import type { RoomPatchSectionsV2, RoomState, RoomView, RoomViewV2 } from './types';

export { compactRoundResult };

/**
 * Delivery for 图寻 rooms on the room kernel.
 *
 * - v2 (current client): one public patch per revision to the room channel, a
 *   seat-private patch only for the seat whose guess changed, compact results
 *   and no map catalogue after the first view.
 * - v1 (pages opened before the upgrade): the original full RoomView shape and
 *   top-level `location:room:patch`, now generated from the changed sections.
 *
 * Seats are subscribed explicitly by the page (state/create/join/answer), so a
 * tab on another page never receives room traffic and cannot steal the seat.
 */
export type LocationProtocol = 1 | 2;

export const publicChannel = (roomId: string) => `location:room:${roomId}`;
export const seatChannel = (roomId: string, identity: string) => `location:room:${roomId}:seat:${identity}`;
export const v1Channel = (roomId: string, identity: string) => `location:room:${roomId}:v1:${identity}`;

export function socketProtocol(socket: Socket): LocationProtocol {
  return socket.data.roomProtocols?.location === 2 ? 2 : 1;
}

export function mapsHash(room: RoomState): string | null {
  if (!room.maps.length) return null;
  if (room.mapsHash) return room.mapsHash;
  return createHash('sha256').update(JSON.stringify(room.maps)).digest('hex').slice(0, 16);
}

export function v2View(room: RoomState, identity: string, options: { includeMaps?: boolean } = {}, now = Date.now(), common?: Pick<RoomView, 'results' | 'players'>): RoomViewV2 {
  const view = roomView(room, identity, now, common);
  const { maps, results, ...rest } = view;
  const hash = mapsHash(room);
  return {
    ...rest,
    protocol: 2,
    mapsHash: hash,
    ...(options.includeMaps !== false && maps.length ? { maps } : {}),
    results: results.map((player) => ({ key: player.key, name: player.name, rounds: player.rounds.map(compactRoundResult) })),
  };
}

export function viewFor(room: RoomState, identity: string, protocol: LocationProtocol, knownMapsHash?: string | null): RoomView | RoomViewV2 {
  if (protocol === 1) return roomView(room, identity);
  return v2View(room, identity, { includeMaps: !knownMapsHash || knownMapsHash !== mapsHash(room) });
}

/** Subscribe one socket to a room for its negotiated protocol (leaving a previous room). */
export async function subscribeSocket(socket: Socket, room: RoomState, identity: string, protocol = socketProtocol(socket)): Promise<void> {
  const previous = socket.data.locationRoomChannels as string[] | undefined;
  const channels = protocol === 2
    ? [publicChannel(room.id), seatChannel(room.id, identity)]
    : [v1Channel(room.id, identity)];
  if (previous?.length) for (const channel of previous) if (!channels.includes(channel)) await socket.leave(channel);
  await socket.join(channels);
  socket.data.locationRoomChannels = channels;
  socket.data.locationRoomId = room.id;
}

export async function unsubscribeSocket(socket: Socket): Promise<void> {
  const previous = socket.data.locationRoomChannels as string[] | undefined;
  if (previous?.length) for (const channel of previous) await socket.leave(channel);
  socket.data.locationRoomChannels = [];
  socket.data.locationRoomId = null;
}

/** Subscribe a socket that may live on another instance (matchmaking opponent). */
export async function subscribeRemote(io: Server, socketId: string, room: RoomState, identity: string, protocol: LocationProtocol): Promise<void> {
  const channels = protocol === 2
    ? [publicChannel(room.id), seatChannel(room.id, identity)]
    : [v1Channel(room.id, identity)];
  await io.in(socketId).socketsJoin(channels);
}

function v1Changes(_room: RoomState, changes: RoomChanges, view: RoomView, identity: string): Partial<RoomView> {
  const patch: Partial<RoomView> = { revision: view.revision, serverNow: view.serverNow };
  const s = changes.sections;
  if (s.has('rematch')) patch.rematch = view.rematch;
  if (s.has('status')) patch.status = view.status;
  if (s.has('round')) patch.round = view.round;
  if (s.has('timers')) {
    patch.startsAt = view.startsAt;
    patch.endsAt = view.endsAt;
    patch.nextAt = view.nextAt;
  }
  if (s.has('question')) patch.question = view.question;
  if (s.has('host')) patch.host = view.host;
  if (s.has('players')) patch.players = view.players;
  if (s.has('results')) patch.results = view.results;
  if (s.has('maps')) patch.maps = view.maps;
  if (changes.clearMyGuess || changes.myGuess.has(identity)) patch.myGuess = view.myGuess;
  return patch;
}

/**
 * Emit exactly one revision. `previousRevision` is the revision the patch
 * applies to, so remote and local sockets receive the same patch.
 */
export function emitRevision(io: Server, room: RoomState, changes: RoomChanges, previousRevision: number): void {
  if (!room.players.length) return;
  if (changes.sections.has('reset')) {
    for (const player of room.players) {
      emitTo(io, seatChannel(room.id, player.identity.key), 'location:room', v2View(room, player.identity.key), 'location.v2.full');
      if (room.v1Seats?.includes(player.identity.key))
        emitTo(io, v1Channel(room.id, player.identity.key), 'location:room', roomView(room, player.identity.key), 'location.v1.full');
    }
    return;
  }
  const now = Date.now();
  const common = roomView(room, room.players[0].identity.key, now);
  const publicKey = (identity: string) => publicPlayerKey(room.gameId, identity);
  const s = changes.sections;

  const sections: RoomPatchSectionsV2 = {};
  if (s.has('rematch')) sections.rematch = common.rematch;
  if (s.has('status')) sections.status = room.status;
  if (s.has('round')) sections.round = room.round;
  if (s.has('timers')) {
    sections.startsAt = room.startsAt;
    sections.endsAt = room.endsAt;
    sections.nextAt = room.nextAt;
  }
  if (s.has('question')) sections.question = common.question;
  if (s.has('host')) sections.host = publicKey(room.host);
  if (s.has('players') || s.has('results')) sections.players = common.players;
  if (changes.revealed) {
    sections.resultsAppend = common.results.flatMap((player) =>
      player.rounds.slice(-changes.revealed).map((round) => ({ key: player.key, round: compactRoundResult(round) })));
  }
  if (s.has('maps')) {
    sections.maps = room.maps;
    sections.mapsHash = mapsHash(room);
  }
  if (changes.clearMyGuess) sections.clearMyGuess = true;
  emitTo(io, publicChannel(room.id), 'room-kernel:patch', {
    game: 'location', roomId: room.id, base: previousRevision, rev: room.revision, serverNow: now, sections,
  }, 'location.v2.patch');

  for (const identity of changes.myGuess) {
    const p = room.players.find((item) => item.identity.key === identity);
    if (!p) continue;
    emitTo(io, seatChannel(room.id, identity), 'room-kernel:private', {
      game: 'location', roomId: room.id, rev: room.revision, private: { myGuess: p.currentGuess },
    }, 'location.v2.private');
  }

  for (const identity of room.v1Seats ?? []) {
    if (!room.players.some((p) => p.identity.key === identity)) continue;
    const view = roomView(room, identity, now, common);
    emitTo(io, v1Channel(room.id, identity), 'location:room:patch', {
      id: room.id, baseRevision: previousRevision, revision: room.revision, changes: v1Changes(room, changes, view, identity),
    }, 'location.v1.patch');
  }
}

/** Full first view for a socket subscribed on its behalf (matchmaking opponent). */
export function emitFullView(io: Server, socketId: string, room: RoomState, identity: string, protocol: LocationProtocol): void {
  emitTo(io, socketId, 'location:room', viewFor(room, identity, protocol), `location.v${protocol}.full`);
}
