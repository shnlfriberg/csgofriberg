import { HttpError } from '../middleware/common';
import { assertGuess } from './rules';
import type { AnswerInput, Identity, QuestionSnapshot, RoomPlayer, RoomState } from './types';

/**
 * 图寻 multiplayer state machine, the game engine plugged into the room kernel.
 * Pure functions over RoomState: callers persist, schedule and broadcast. Each
 * mutation records which view sections changed so the protocol can send exact
 * patches instead of diffing serialized views.
 *
 * waiting → preparing (3 s) → playing → round_over (8 s) → … → finished (5 rounds)
 * waiting rooms expire after 30 minutes; disconnected seats get a 30 s grace.
 */
export const LOCATION_ROUNDS = 5;
export const PREPARE_MS = 3_000;
export const REVEAL_MS = 8_000;
export const WAITING_TTL_MS = 1_800_000;
export const DISCONNECT_GRACE_MS = 30_000;
export const MAX_ROOM_PLAYERS = 8;

export type RoomSection =
  | 'status'
  | 'round'
  | 'timers'
  | 'question'
  | 'host'
  | 'players'
  | 'results'
  | 'maps';

export interface RoomChanges {
  sections: Set<RoomSection>;
  /** Identity keys whose private guess changed (answers). */
  myGuess: Set<string>;
  /** Every seat's guess was reset by a new round. */
  clearMyGuess: boolean;
  /** Number of rounds revealed in this revision. */
  revealed: number;
  /** Identity keys that stopped occupying the room (left, removed, retired). */
  released: Set<string>;
  /** Identity keys that newly occupy the room. */
  joined: Set<string>;
  /** Force a write even without public changes (internal bookkeeping). */
  internal: boolean;
}

export function newChanges(): RoomChanges {
  return {
    sections: new Set(),
    myGuess: new Set(),
    clearMyGuess: false,
    revealed: 0,
    released: new Set(),
    joined: new Set(),
    internal: false,
  };
}

export function hasChanges(changes: RoomChanges): boolean {
  return changes.sections.size > 0 || changes.myGuess.size > 0 || changes.clearMyGuess
    || changes.released.size > 0 || changes.joined.size > 0 || changes.internal;
}

export const isTerminal = (room: Pick<RoomState, 'status'>) => room.status === 'finished' || room.status === 'cancelled';

export function newPlayer(identity: Identity, socketId: string): RoomPlayer {
  return {
    identity,
    socketId,
    ready: false,
    connected: true,
    disconnectAt: null,
    retired: false,
    guesses: [],
    currentGuess: null,
    requests: {},
  };
}

/** Members that hold the site-wide occupancy seat. */
export function occupyingKeys(room: RoomState): string[] {
  if (isTerminal(room)) return [];
  return room.players.filter((p) => !p.retired).map((p) => p.identity.key);
}

/** The next moment at which `advance` would change something. */
export function nextDeadline(room: RoomState): number | null {
  if (isTerminal(room)) return null;
  const candidates: number[] = [];
  if (room.status === 'waiting') candidates.push(room.createdAt + WAITING_TTL_MS);
  for (const value of [room.startsAt, room.endsAt, room.nextAt]) if (value !== null) candidates.push(value);
  for (const p of room.players) if (!p.connected && p.disconnectAt !== null) candidates.push(p.disconnectAt);
  return candidates.length ? Math.min(...candidates) : null;
}

/**
 * Apply every due transition. Returns whether anything changed (the original
 * `advanceRoom` contract) and records the changed sections when given.
 * Disconnect grace does not expire while a maintenance window is active.
 */
export function advance(
  room: RoomState,
  now = Date.now(),
  changes: RoomChanges = newChanges(),
  graceFrozenUntil = 0
): boolean {
  let changed = false;
  if (isTerminal(room)) return false;
  if (graceFrozenUntil <= now) {
    for (const p of [...room.players])
      if (!p.connected && p.disconnectAt !== null && p.disconnectAt <= now) {
        if (room.status === 'waiting') room.players = room.players.filter((other) => other !== p);
        else p.retired = true;
        p.disconnectAt = null;
        changes.released.add(p.identity.key);
        changes.sections.add('players');
        changed = true;
      }
  }
  if (!room.players.length || (room.status !== 'waiting' && room.players.every((p) => p.retired))) {
    room.status = 'cancelled';
    room.startsAt = room.endsAt = room.nextAt = null;
    for (const p of room.players) changes.released.add(p.identity.key);
    changes.sections.add('status').add('timers').add('question');
    return true;
  }
  if (room.status === 'waiting') {
    if (!room.players.some((p) => p.identity.key === room.host)) {
      room.host = room.players[0].identity.key;
      changes.sections.add('host');
      changed = true;
    }
    if (room.createdAt + WAITING_TTL_MS <= now) {
      room.status = 'cancelled';
      for (const p of room.players) changes.released.add(p.identity.key);
      changes.sections.add('status');
      changed = true;
    }
    return changed;
  }
  if (room.status === 'round_over' && room.nextAt! <= now) {
    room.round++;
    for (const p of room.players) p.currentGuess = null;
    room.status = 'preparing';
    room.startsAt = now + PREPARE_MS;
    room.endsAt = room.startsAt + room.duration * 1000;
    room.nextAt = null;
    changes.clearMyGuess = true;
    changes.sections.add('status').add('round').add('timers').add('question').add('players');
    changed = true;
  }
  if (room.status === 'preparing' && room.startsAt! <= now) {
    room.status = 'playing';
    room.startsAt = null;
    changes.sections.add('status').add('timers').add('question');
    changed = true;
  }
  if (
    room.status === 'playing' &&
    (room.endsAt! <= now || room.players.filter((p) => !p.retired).every((p) => p.currentGuess !== null))
  ) {
    for (const p of room.players) p.guesses.push(p.retired ? null : p.currentGuess);
    room.endsAt = null;
    room.startsAt = null;
    room.status = room.round === LOCATION_ROUNDS ? 'finished' : 'round_over';
    room.nextAt = room.round === LOCATION_ROUNDS ? null : now + REVEAL_MS;
    if (room.status === 'finished') for (const p of room.players) changes.released.add(p.identity.key);
    changes.revealed++;
    changes.sections.add('status').add('timers').add('question').add('players').add('results');
    changed = true;
  }
  return changed;
}

export function requirePlayer(room: RoomState, key: string): RoomPlayer {
  const p = room.players.find((item) => item.identity.key === key);
  if (!p) throw new HttpError(403, 'FORBIDDEN');
  return p;
}

export function joinPlayer(room: RoomState, identity: Identity, socketId: string, changes: RoomChanges): RoomPlayer {
  const existing = room.players.find((p) => p.identity.key === identity.key);
  if (existing) {
    if (existing.retired) throw new HttpError(403, 'LOCATION_RETIRED');
    return existing;
  }
  if (room.status !== 'waiting' || room.players.length >= MAX_ROOM_PLAYERS)
    throw new HttpError(409, 'LOCATION_ROOM_UNAVAILABLE');
  const p = newPlayer(identity, socketId);
  room.players.push(p);
  changes.joined.add(identity.key);
  changes.sections.add('players');
  return p;
}

export function leavePlayer(room: RoomState, key: string, changes: RoomChanges): void {
  const p = requirePlayer(room, key);
  if (isTerminal(room)) return;
  if (room.status === 'waiting') room.players = room.players.filter((other) => other !== p);
  else {
    if (p.retired) return;
    p.retired = true;
    p.connected = false;
    p.disconnectAt = null;
  }
  changes.released.add(key);
  changes.sections.add('players');
}

export function setReady(room: RoomState, key: string, ready: boolean, changes: RoomChanges): void {
  if (room.status !== 'waiting') throw new HttpError(409, 'LOCATION_ROUND_LOCKED');
  const p = requirePlayer(room, key);
  if (p.ready === ready) return;
  p.ready = ready;
  changes.sections.add('players');
}

/** Online/offline transition from the kernel presence registry. */
export function setPresence(room: RoomState, key: string, online: boolean, now: number, changes: RoomChanges): void {
  if (isTerminal(room)) return;
  const p = room.players.find((item) => item.identity.key === key);
  if (!p || p.retired) return;
  if (online) {
    if (p.connected && p.disconnectAt === null) return;
    p.connected = true;
    p.disconnectAt = null;
  } else {
    if (!p.connected) return;
    p.connected = false;
    p.disconnectAt = now + DISCONNECT_GRACE_MS;
  }
  changes.sections.add('players');
}

export function startGame(
  room: RoomState,
  selection: { questions: QuestionSnapshot[]; maps: RoomState['maps'] },
  now: number,
  changes: RoomChanges
): void {
  room.questions = selection.questions;
  room.maps = selection.maps;
  room.round = 1;
  room.status = 'preparing';
  room.startsAt = now + PREPARE_MS;
  room.endsAt = room.startsAt + room.duration * 1000;
  changes.sections.add('status').add('round').add('timers').add('question').add('maps').add('players');
}

export function assertStartable(room: RoomState): void {
  if (room.status !== 'waiting' || room.players.length < 2 || !room.players.every((p) => p.ready && p.connected))
    throw new HttpError(409, 'LOCATION_NOT_READY');
}

/** Record a guess; idempotent for the same request id. Returns false for a replay. */
export function answer(room: RoomState, key: string, input: AnswerInput, now: number, changes: RoomChanges): boolean {
  const p = room.players.find((item) => item.identity.key === key);
  if (!p || p.retired) throw new HttpError(403, 'LOCATION_RETIRED');
  const fingerprint = JSON.stringify(input);
  if (p.requests[input.requestId]) {
    if (p.requests[input.requestId] !== fingerprint) throw new HttpError(409, 'LOCATION_REQUEST_CONFLICT');
    return false;
  }
  if (input.round !== room.round || input.version !== room.round || room.status !== 'playing' || room.endsAt! <= now)
    throw new HttpError(409, 'LOCATION_ROUND_LOCKED');
  if (p.currentGuess) throw new HttpError(409, 'LOCATION_ROUND_LOCKED');
  assertGuess(input, room.maps);
  p.currentGuess = { mapId: input.mapId, floorId: input.floorId, u: input.u, v: input.v };
  p.requests[input.requestId] = fingerprint;
  changes.myGuess.add(key);
  changes.sections.add('players');
  return true;
}
