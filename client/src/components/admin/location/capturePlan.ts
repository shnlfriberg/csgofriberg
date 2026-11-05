import type {
  CaptureAsset,
  CapturePointInput,
  MapDefinition,
} from '../../../location/types';

export const CAPTURE_STORAGE_KEY = 'tuxun:capture-points:v2';
export type CaptureImageRow = {
  id: string;
  file: File;
  preview: string;
  target: string;
  error?: string;
  asset?: CaptureAsset;
};

export function restoreCapturePoints(
  maps: MapDefinition[]
): CapturePointInput[] {
  try {
    // v1 contained the disposable plans from the earlier authoring prototype.
    const value: unknown = JSON.parse(
      localStorage.getItem(CAPTURE_STORAGE_KEY) || '[]'
    );
    if (!Array.isArray(value)) return [];
    const seen = new Set<string>();
    return value
      .filter((point): point is CapturePointInput => {
        if (!point || typeof point !== 'object') return false;
        const map = maps.find((map) => map.id === point.mapId);
        const valid =
          map?.floors.some((floor) => floor.id === point.floorId) &&
          typeof point.id === 'string' &&
          /^[a-f0-9-]{36}$/i.test(point.id) &&
          typeof point.batchId === 'string' &&
          /^[a-f0-9-]{36}$/i.test(point.batchId) &&
          typeof point.batchName === 'string' &&
          point.batchName.length > 0 &&
          point.batchName.length <= 100 &&
          typeof point.capturePointId === 'string' &&
          /^[a-zA-Z0-9_-]{1,64}$/.test(point.capturePointId) &&
          Number.isInteger(point.order) &&
          point.order > 0 &&
          point.order <= 10000 &&
          [point.u, point.v].every(
            (v) =>
              typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1
          ) &&
          !seen.has(point.id);
        if (valid) seen.add(point.id);
        return Boolean(valid);
      })
      .slice(0, 500);
  } catch {
    return [];
  }
}
