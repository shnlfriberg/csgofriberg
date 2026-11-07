import { api } from './api';
import type { MapDefinition } from './types';

/**
 * Enabled map catalogue shared by the solo lobby (map bans) and submissions.
 * One request per minute at most; the server answers with a short private
 * cache and an ETag, so revalidation is a 304 without a body.
 */
const TTL_MS = 60_000;
let cached: { at: number; request: Promise<MapDefinition[]> } | null = null;

export function loadEnabledMaps(force = false): Promise<MapDefinition[]> {
  if (!force && cached && Date.now() - cached.at < TTL_MS) return cached.request;
  const request = api.get<MapDefinition[]>('/location/maps').then((response) => response.data);
  const entry = { at: Date.now(), request };
  cached = entry;
  request.catch(() => {
    if (cached === entry) cached = null;
  });
  return request;
}

/** Test helper. */
export function resetMapCatalogCache(): void {
  cached = null;
}
