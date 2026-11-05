import type { MapDefinition } from './types.js';

export const COORDINATE_TOLERANCE = 0.005;

export function worldToRadar(
  map: MapDefinition,
  world: { x: number; y: number }
) {
  return {
    u: (world.x - map.calibration.posX) / (map.calibration.scale * map.width),
    v: (map.calibration.posY - world.y) / (map.calibration.scale * map.height),
  };
}

export function radarToWorld(
  map: MapDefinition,
  point: { u: number; v: number }
) {
  return {
    x: map.calibration.posX + point.u * map.width * map.calibration.scale,
    y: map.calibration.posY - point.v * map.height * map.calibration.scale,
  };
}

export function coordinateDistance(
  a: { u: number; v: number },
  b: { u: number; v: number }
) {
  return Math.hypot(a.u - b.u, a.v - b.v);
}

export function mapGeometry(map: MapDefinition) {
  return JSON.stringify([
    map.width,
    map.height,
    map.bounds,
    map.floors,
    map.calibration,
  ]);
}
