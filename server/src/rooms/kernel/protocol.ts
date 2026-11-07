/**
 * Room kernel wire protocol shared by every multiplayer game on the server
 * (classic guessing rooms, 图寻 rooms and 卡牌连接 matches).
 *
 * Only transport-level shapes live here; game views and private state stay in
 * each game's module. The web client keeps its own copy of these few shapes in
 * `client/src/api/roomKernel.ts` (the client never imports server code).
 */

export type GameId = 'classic' | 'location' | 'card-link';

export const GAME_IDS: readonly GameId[] = ['classic', 'location', 'card-link'];

export function isGameId(value: unknown): value is GameId {
  return typeof value === 'string' && (GAME_IDS as readonly string[]).includes(value);
}

/** Where an identity currently holds its single site-wide multiplayer seat. */
export interface OccupancyRef {
  game: GameId;
  roomId: string;
  role?: 'player' | 'spectator';
}

export interface OccupancySummary {
  status: string;
  round?: number;
  /** Short code shown to people (card-link uses its invite code). */
  code?: string;
}

/**
 * Extra fields attached to an "already in another room" error. Every game keeps
 * its historical error code (ALREADY_IN_ROOM, LOCATION_ALREADY_IN_ROOM,
 * CARD_ALREADY_PLAYING) so older pages still show a translated message.
 */
export interface OccupiedDetails {
  occupied: OccupancyRef & { summary?: OccupancySummary | null };
}

/** Public room patch: sent once to the room channel for every committed revision. */
export interface KernelPatch<Sections = Record<string, unknown>> {
  game: GameId;
  roomId: string;
  /** Revision the patch applies to. */
  base: number;
  /** Revision after the patch (always base + 1). */
  rev: number;
  serverNow: number;
  sections: Sections;
}

/** Seat-private patch for the same revision (for example the viewer's own guess). */
export interface KernelPrivatePatch<Private = Record<string, unknown>> {
  game: GameId;
  roomId: string;
  rev: number;
  private: Private;
}

/** Pushed to a queued identity when matchmaking paired it into a room. */
export interface KernelFound {
  game: GameId;
  roomId: string;
}

export const KERNEL_EVENTS = {
  hello: 'room-kernel:hello',
  patch: 'room-kernel:patch',
  privatePatch: 'room-kernel:private',
  found: 'room-kernel:found',
} as const;
