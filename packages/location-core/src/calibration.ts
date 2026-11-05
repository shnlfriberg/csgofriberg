import { COORDINATE_TOLERANCE, worldToRadar } from './coordinates.js';
import type { MapDefinition } from './types.js';

type Point = MapDefinition['calibration']['points'][number];
export type CalibrationParameters = Pick<
  MapDefinition['calibration'],
  'posX' | 'posY' | 'scale'
>;

// Use any well-spread triangle, so adding/reordering points cannot invalidate
// a good calibration merely because the first three happen to be collinear.
export function hasCalibrationSpread(points: readonly Point[]): boolean {
  for (let a = 0; a < points.length - 2; a++)
    for (let b = a + 1; b < points.length - 1; b++)
      for (let c = b + 1; c < points.length; c++)
        if (
          Math.abs(
            (points[b].u - points[a].u) * (points[c].v - points[a].v) -
              (points[c].u - points[a].u) * (points[b].v - points[a].v)
          ) > 0.01
        )
          return true;
  return false;
}

/** Fit the axis-aligned CS2 overview transform using measured pairs only.
 * World coordinates are exact inputs; least squares minimizes radar-pixel
 * marking error. Every floor shares this map's original canvas and transform.
 * Existing origin/scale values are deliberately never read here.
 */
export function fitCalibration(map: MapDefinition): CalibrationParameters | null {
  const points = map.calibration.points;
  if (
    !Number.isFinite(map.width) ||
    !Number.isFinite(map.height) ||
    map.width <= 0 ||
    map.height <= 0 ||
    points.some(
      (p) =>
        !map.floors.some((floor) => floor.id === p.floorId) ||
        ![p.x, p.y, p.u, p.v].every(Number.isFinite) ||
        p.u < 0 || p.u > 1 || p.v < 0 || p.v > 1
    ) ||
    !hasCalibrationSpread(points)
  )
    return null;

  const mean = (read: (p: Point) => number) =>
    points.reduce((sum, p) => sum + read(p), 0) / points.length;
  const x = mean((p) => p.x);
  const y = mean((p) => p.y);
  const px = mean((p) => p.u * map.width);
  const py = mean((p) => p.v * map.height);
  let covariance = 0;
  let variance = 0;
  for (const p of points) {
    covariance +=
      (p.x - x) * (p.u * map.width - px) -
      (p.y - y) * (p.v * map.height - py);
    variance += (p.x - x) ** 2 + (p.y - y) ** 2;
  }
  const pixelsPerUnit = covariance / variance;
  if (!Number.isFinite(pixelsPerUnit) || pixelsPerUnit <= 0) return null;
  const scale = 1 / pixelsPerUnit;
  const posX = x - px * scale;
  const posY = y + py * scale;
  return [scale, posX, posY].every(Number.isFinite)
    ? { posX, posY, scale }
    : null;
}

export function applyCalibration(map: MapDefinition): MapDefinition {
  const fitted = fitCalibration(map);
  return fitted
    ? { ...map, calibration: { ...map.calibration, ...fitted } }
    : map;
}

// Check the parameters actually used for conversion, including imported and
// historical maps. Do not silently refit immutable snapshots while reading them.
export function inspectCalibration(map: MapDefinition) {
  const floors = map.floors.map((floor) => {
    const points = map.calibration.points.filter((p) => p.floorId === floor.id);
    return {
      floorId: floor.id,
      count: points.length,
      ready: Boolean(floor.radarUrl) && hasCalibrationSpread(points),
    };
  });
  const points = map.calibration.points.map((point) => {
    const predicted = worldToRadar(map, point);
    const du = predicted.u - point.u;
    const dv = predicted.v - point.v;
    const error = Math.hypot(du, dv);
    return {
      error,
      pixels: Math.hypot(du * map.width, dv * map.height),
      valid: Number.isFinite(error) && error <= COORDINATE_TOLERANCE,
    };
  });
  const parametersValid =
    [map.width, map.height, map.calibration.scale].every(
      (n) => Number.isFinite(n) && n > 0
    ) &&
    [map.calibration.posX, map.calibration.posY].every(Number.isFinite);
  return {
    floors,
    points,
    valid:
      parametersValid &&
      floors.length > 0 &&
      floors.every((floor) => floor.ready) &&
      map.calibration.points.every(
        (p) =>
          map.floors.some((floor) => floor.id === p.floorId) &&
          [p.x, p.y, p.u, p.v].every(Number.isFinite) &&
          p.u >= 0 && p.u <= 1 && p.v >= 0 && p.v <= 1
      ) &&
      points.every((point) => point.valid),
  };
}
