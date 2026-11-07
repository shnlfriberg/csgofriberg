import type { GameId, OccupancySummary } from './protocol';
import type { Server, Socket } from 'socket.io';

/**
 * How the kernel decides that a seat is online:
 * - `identity`: any live socket of the identity (图寻 rooms);
 * - `watch`: any live socket currently watching that room (卡牌连接);
 * - `custom`: the game binds seats to sockets itself (classic rooms).
 */
export type PresencePolicy = 'identity' | 'watch' | 'custom';

export interface PresenceChange {
  game: GameId;
  roomId: string;
  identityKey: string;
  online: boolean;
  cause: 'connect' | 'disconnect' | 'unwatch' | 'reap' | 'reconcile';
}

export interface GameRoomAdapter {
  readonly game: GameId;
  readonly presence: PresencePolicy;
  /** Highest client protocol version this game serves (announced via room-kernel:hello). */
  readonly protocolVersion?: number;
  /**
   * Cheap, read-only membership check used to self-heal occupancy.
   * `false` = definitely not an active member; `null` = unknown (keep the claim).
   */
  isActiveMember(roomId: string, identityKey: string): Promise<'player' | 'spectator' | false | null>;
  /** Short status for the "you are already in another room" dialog. */
  describe?(roomId: string, identityKey: string): Promise<OccupancySummary | null>;
  /** Presence transitions for `identity`/`watch` policies; must be idempotent. */
  onPresence?(change: PresenceChange): Promise<void>;
  /** Drop the identity from this game's matchmaking queue (cross-game exclusivity). */
  cancelQueue?(identityKey: string): Promise<void>;
  /** Startup adoption of state that predates the kernel (idempotent). */
  adopt?(): Promise<void>;
}

const adapters = new Map<GameId, GameRoomAdapter>();
let kernelIo: Server | null = null;

export function registerRoomAdapter(adapter: GameRoomAdapter): () => void {
  adapters.set(adapter.game, adapter);
  return () => {
    if (adapters.get(adapter.game) === adapter) adapters.delete(adapter.game);
  };
}

export function getRoomAdapter(game: GameId): GameRoomAdapter | undefined {
  return adapters.get(game);
}

export function roomAdapters(): GameRoomAdapter[] {
  return [...adapters.values()];
}

export function setKernelIo(io: Server | null): void {
  kernelIo = io;
}

export function getKernelIo(): Server | null {
  return kernelIo;
}

export type ConnectionHook = (socket: Socket) => void;
