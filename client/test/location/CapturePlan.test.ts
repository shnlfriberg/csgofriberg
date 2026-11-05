import { describe, expect, it } from 'vitest';
import {
  CAPTURE_STORAGE_KEY,
  restoreCapturePoints,
} from '../../src/components/admin/location/capturePlan';
import type {
  CapturePointInput,
  MapDefinition,
} from '../../src/location/types';

const map: MapDefinition = {
  id: 'de_dust2',
  name: 'Dust2',
  enabled: true,
  order: 0,
  version: 1,
  width: 1024,
  height: 1024,
  floors: [{ id: 'main', name: 'main', radarUrl: '/dust.webp' }],
  bounds: { u: 0, v: 0, width: 1, height: 1 },
  calibration: { posX: 0, posY: 0, scale: 1, points: [] },
};
const point: CapturePointInput = {
  id: '00000000-0000-4000-8000-000000000001',
  batchId: '00000000-0000-4000-8000-000000000002',
  batchName: 'My batch',
  order: 1,
  capturePointId: 'tx-001',
  mapId: map.id,
  floorId: 'main',
  u: 0.2,
  v: 0.4,
};

describe('capture plan restoration', () => {
  it('filters broken, duplicate and unavailable points before they reach the radar', () => {
    localStorage.setItem(
      CAPTURE_STORAGE_KEY,
      JSON.stringify([
        null,
        {},
        point,
        point,
        { ...point, id: 'broken' },
        { ...point, floorId: 'gone' },
        { ...point, u: 8 },
      ])
    );
    expect(restoreCapturePoints([map])).toEqual([point]);
    expect(restoreCapturePoints([])).toEqual([]);
  });
  it('does not restore the discarded prototype namespace', () => {
    localStorage.setItem('tuxun:capture-points:v1', JSON.stringify([point]));
    expect(restoreCapturePoints([map])).toEqual([]);
  });
});
