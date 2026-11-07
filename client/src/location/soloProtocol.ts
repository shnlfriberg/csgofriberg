import {
  applyLocationSoloDelta,
  hydrateLocationSoloView,
  isLocationSoloDelta,
  isLocationSoloView,
  type LocationSoloDelta,
  type LocationSoloView,
} from '@friberg/location-core';
import type { GameView, MapDefinition } from './types';

/**
 * 图寻 单人 on the shared single-player API (`/api/game`, variant `location`),
 * client side. The server sends a game's map snapshot only when this page does
 * not report holding it, results carry map ids, and an accepted guess is a
 * delta. Everything is rebuilt into the original GameView so rendering is
 * unchanged. Full GameViews from the daily endpoints pass through untouched.
 */
const MAX_CATALOGUES = 8;
const catalogues = new Map<string, MapDefinition[]>();
const gameHashes = new Map<string, string>();
let latestHash: string | null = null;

export type SoloResponse = GameView | LocationSoloView | LocationSoloDelta;

export class MapsUnknownError extends Error {
  constructor() {
    super('LOCATION_MAPS_UNKNOWN');
  }
}

function remember(hash: string, maps: MapDefinition[]) {
  catalogues.delete(hash);
  catalogues.set(hash, maps);
  while (catalogues.size > MAX_CATALOGUES) {
    const oldest = catalogues.keys().next().value!;
    if (oldest === hash || oldest === latestHash) break;
    catalogues.delete(oldest);
  }
}

/** Request options: the map snapshot this page already holds, if any. */
export function soloRequest(gameId?: string | null, withoutMaps = false) {
  const known = withoutMaps ? null : (gameId && gameHashes.get(gameId)) || latestHash;
  return known && catalogues.has(known) ? { headers: { 'X-Location-Maps': known } } : {};
}

/** A full view in either shape, as the original GameView. */
export function receiveGame(data: GameView | LocationSoloView): GameView {
  if (!isLocationSoloView(data)) return data;
  // Reuse the cached array so memoised map/radar components keep their props.
  const maps = catalogues.get(data.mapsHash) ?? data.maps;
  if (!maps) throw new MapsUnknownError();
  remember(data.mapsHash, maps);
  latestHash = data.mapsHash;
  gameHashes.set(data.gameId, data.mapsHash);
  if (gameHashes.size > 64) gameHashes.delete(gameHashes.keys().next().value!);
  return hydrateLocationSoloView(data, maps);
}

/**
 * Apply a guess response. Returns null when a delta does not follow the held
 * version (the game moved on elsewhere); the caller then re-reads the game.
 */
export function receiveAnswer(current: GameView, data: SoloResponse): GameView | null {
  if (isLocationSoloDelta(data)) return applyLocationSoloDelta(current, data);
  return receiveGame(data);
}

/** Test helper. */
export function resetSoloProtocolCache(): void {
  catalogues.clear();
  gameHashes.clear();
  latestHash = null;
}
