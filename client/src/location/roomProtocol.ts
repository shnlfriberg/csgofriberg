import { hydrateRoundResult, type CompactRoundResult } from '@friberg/location-core';
import type { Guess, MapDefinition, RoomView, RoundResult } from './types';

export { hydrateRoundResult, type CompactRoundResult };

/**
 * 图寻 multiplayer protocol v2 (room kernel) — client side.
 *
 * The server omits the map catalogue after the first view and replaces the two
 * MapDefinitions in every round result by ids. These helpers rebuild the full
 * RoomView shape so the existing rendering code stays unchanged. Both maps come
 * from the room's catalogue snapshot, so rehydration is lossless.
 */
export const LOCATION_ROOM_PROTOCOL = 2;

export interface RoomViewV2 extends Omit<RoomView, 'maps' | 'results'> {
  protocol: 2;
  maps?: MapDefinition[];
  mapsHash: string | null;
  results: Array<{ key: string; name: string; rounds: CompactRoundResult[] }>;
}

export interface RoomPatchSectionsV2 {
  status?: RoomView['status'];
  round?: number;
  startsAt?: number | null;
  endsAt?: number | null;
  nextAt?: number | null;
  question?: RoomView['question'];
  host?: string;
  players?: RoomView['players'];
  resultsAppend?: Array<{ key: string; round: CompactRoundResult }>;
  maps?: MapDefinition[];
  mapsHash?: string | null;
  clearMyGuess?: true;
}

export interface RoomPatchV2 {
  game: 'location';
  roomId: string;
  base: number;
  rev: number;
  serverNow: number;
  sections: RoomPatchSectionsV2;
}

export interface RoomPrivatePatchV2 {
  game: 'location';
  roomId: string;
  rev: number;
  private: { myGuess: Guess | null };
}

export function isRoomViewV2(value: unknown): value is RoomViewV2 {
  return Boolean(value && typeof value === 'object' && (value as { protocol?: unknown }).protocol === 2);
}

/** Rebuild the full RoomView from a v2 view and the maps the client holds. */
export function hydrateRoomView(view: RoomViewV2, maps: readonly MapDefinition[]): RoomView {
  const { protocol: _protocol, mapsHash: _mapsHash, maps: _maps, results, ...rest } = view;
  return {
    ...rest,
    maps: maps as MapDefinition[],
    results: results.map((player) => ({
      key: player.key,
      name: player.name,
      rounds: player.rounds.map((round) => hydrateRoundResult(round, maps)),
    })),
  };
}

/**
 * Merge one public v2 patch into a hydrated view. Returns null when it cannot be
 * applied (for example the maps are unknown), in which case the caller resyncs.
 */
export function applyRoomPatchV2(view: RoomView, patch: RoomPatchV2, maps: readonly MapDefinition[]): RoomView | null {
  const sections = patch.sections;
  const nextMaps = sections.maps ?? maps;
  // Keep the same array reference when the catalogue did not change, so memoized
  // question and radar components do not re-render for every patch.
  const next: RoomView = { ...view, revision: patch.rev, serverNow: patch.serverNow, maps: sections.maps ?? view.maps };
  if (sections.status !== undefined) next.status = sections.status;
  if (sections.round !== undefined) next.round = sections.round;
  if (sections.startsAt !== undefined) next.startsAt = sections.startsAt;
  if (sections.endsAt !== undefined) next.endsAt = sections.endsAt;
  if (sections.nextAt !== undefined) next.nextAt = sections.nextAt;
  if (sections.question !== undefined) next.question = sections.question;
  if (sections.host !== undefined) next.host = sections.host;
  if (sections.players !== undefined) next.players = sections.players;
  if (sections.clearMyGuess) next.myGuess = null;
  if (sections.resultsAppend?.length) {
    try {
      const appended = new Map<string, RoundResult[]>();
      for (const item of sections.resultsAppend) {
        const list = appended.get(item.key) ?? [];
        list.push(hydrateRoundResult(item.round, nextMaps));
        appended.set(item.key, list);
      }
      const known = new Set(view.results.map((result) => result.key));
      next.results = view.results.map((result) => ({ ...result, rounds: [...result.rounds, ...(appended.get(result.key) ?? [])] }));
      for (const [key, rounds] of appended) {
        if (known.has(key)) continue;
        next.results.push({ key, name: next.players.find((item) => item.key === key)?.name ?? '', rounds });
      }
    } catch {
      return null;
    }
  }
  return next;
}
