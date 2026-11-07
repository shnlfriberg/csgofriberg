import type { Socket } from 'socket.io-client';
import { getSocket } from './socket';

/**
 * Client side of the server room kernel shared by classic rooms, 图寻 rooms
 * and 卡牌连接 matches. These few wire shapes mirror
 * `server/src/rooms/kernel/protocol.ts` (the client never imports server code).
 */
export type GameId = 'classic' | 'location' | 'card-link';

/** Envelope ACK used by entertainment multiplayer Socket commands. */
export function roomAction<T>(event: string, payload: unknown): Promise<T> {
  return new Promise<T>((resolve, reject) => getSocket().timeout(10000).emit(event, payload,
    (error: unknown, result: { ok: boolean; code?: string; data: T; occupied?: unknown }) => {
      if (error) reject(error);
      else if (!result?.ok) reject({ code: result?.code || 'INTERNAL_ERROR', ...(result?.occupied ? { occupied: result.occupied } : {}) });
      else resolve(result.data);
    }));
}

export interface OccupancySummary {
  status: string;
  round?: number;
  code?: string;
}

export interface OccupancyRef {
  game: GameId;
  roomId: string;
  role?: 'player' | 'spectator';
  summary?: OccupancySummary | null;
}

/** Protocol versions this client speaks, announced once per socket connection. */
const SUPPORTED: Partial<Record<GameId, number>> = { location: 2 };
const HELLO_TIMEOUT_MS = 3000;
let negotiated: { socket: Socket; id: string | undefined; promise: Promise<Partial<Record<GameId, number>>> } | null = null;

/**
 * Negotiate protocol versions for the current connection. Old servers do not
 * answer; the promise then resolves to `{}` and pages keep using protocol v1.
 */
export function negotiateRoomProtocols(socket: Socket = getSocket()): Promise<Partial<Record<GameId, number>>> {
  if (negotiated && negotiated.socket === socket && negotiated.id === socket.id && socket.connected) return negotiated.promise;
  const promise = new Promise<Partial<Record<GameId, number>>>((resolve) => {
    if (!socket.connected || typeof socket.timeout !== 'function') {
      resolve({});
      return;
    }
    socket.timeout(HELLO_TIMEOUT_MS).emit('room-kernel:hello', { protocols: SUPPORTED }, (error: unknown, result: { ok?: boolean; protocols?: Partial<Record<GameId, number>> }) => {
      resolve(!error && result?.ok ? result.protocols ?? {} : {});
    });
  });
  negotiated = { socket, id: socket.id, promise };
  return promise;
}

export async function roomProtocol(game: GameId): Promise<number> {
  return (await negotiateRoomProtocols())[game] ?? 1;
}

const GAMES: GameId[] = ['classic', 'location', 'card-link'];

/** Extract the "seated elsewhere" details from an ack or HTTP error, if any. */
export function occupiedOf(value: unknown): OccupancyRef | null {
  const source = value as { occupied?: unknown; response?: { data?: { occupied?: unknown } } } | null;
  const occupied = (source?.occupied ?? source?.response?.data?.occupied) as Partial<OccupancyRef> | undefined;
  if (!occupied || typeof occupied.roomId !== 'string' || !GAMES.includes(occupied.game as GameId)) return null;
  return occupied as OccupancyRef;
}

const locationRoomKey = (userId: number | null | undefined) => `location:room:${userId || 'guest'}`;

/** Where the player continues an occupied room. */
export function occupiedPath(ref: OccupancyRef, userId?: number | null): string {
  if (ref.game === 'classic') return '/multi/room';
  if (ref.game === 'location') {
    try {
      sessionStorage.setItem(locationRoomKey(userId), ref.roomId);
    } catch {
      /* the page also restores from its own storage */
    }
    return '/entertainment/location/multi';
  }
  return '/entertainment/card-link';
}

/** Leave the occupied room through that game's own leave action. */
export async function leaveOccupied(ref: OccupancyRef): Promise<void> {
  if (ref.game === 'card-link') {
    await roomAction('card-link:control', { id: ref.roomId, action: 'leave', requestId: crypto.randomUUID() });
    return;
  }
  const socket = getSocket();
  const [event, payload] = ref.game === 'classic'
    ? ['room:leave', {}]
    : ['location:room:leave', { roomId: ref.roomId }];
  await new Promise<void>((resolve, reject) => {
    socket.timeout(10000).emit(event, payload, (error: unknown, result: { ok?: boolean; code?: string } | undefined) => {
      if (error) reject(error);
      else if (result && (result.ok === false || (result.code && result.code !== 'NOT_IN_ROOM'))) reject(result);
      else resolve();
    });
  });
}
