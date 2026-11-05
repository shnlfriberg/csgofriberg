import { describe, expect, it } from 'vitest';
import {
  applyCalibration,
  fitCalibration,
  hasCalibrationSpread,
  inspectCalibration,
} from '../../src/location/calibration';
import { radarToWorld, worldToRadar } from '../../src/location/coordinates';
import type { MapDefinition } from '../../src/location/types';

function measuredMap(width = 1024, height = 1024): MapDefinition {
  return {
    id: 'test_calibration', name: 'TEST ONLY', enabled: false, order: 0,
    version: 1, width, height,
    bounds: { u: 0, v: 0, width: 1, height: 1 },
    floors: [{ id: 'main', name: 'Main', radarUrl: '/test.webp' }],
    calibration: {
      posX: 99999, posY: -99999, scale: 900,
      points: [
        { u: .1, v: .1 }, { u: .9, v: .1 },
        { u: .1, v: .9 }, { u: .9, v: .9 },
      ].map(p => ({ ...p, x: -3100 + p.u * width * 3.75,
        y: 4200 - p.v * height * 3.75, floorId: 'main' })),
    },
  };
}

describe('calibration from measured reference pairs', () => {
  it.each([[1024, 1024], [1000, 500]])('fits %s×%s maps without reading old parameters', (width, height) => {
    const map = measuredMap(width, height);
    const original = structuredClone(map);
    const fitted = fitCalibration(map)!;
    expect(fitted.posX).toBeCloseTo(-3100, 8);
    expect(fitted.posY).toBeCloseTo(4200, 8);
    expect(fitted.scale).toBeCloseTo(3.75, 10);
    const other = structuredClone(map);
    other.calibration = { ...other.calibration, posX: -1e9, posY: NaN, scale: .001 };
    expect(fitCalibration(other)).toEqual(fitted);
    expect(map).toEqual(original);
    const calibrated = applyCalibration(map);
    expect(inspectCalibration(calibrated).valid).toBe(true);
    expect(applyCalibration(calibrated)).toEqual(calibrated);
    for (const p of calibrated.calibration.points) {
      const radar = worldToRadar(calibrated, p);
      expect(radar.u).toBeCloseTo(p.u, 12);
      expect(radar.v).toBeCloseTo(p.v, 12);
      const world = radarToWorld(calibrated, radar);
      expect(world.x).toBeCloseTo(p.x, 8);
      expect(world.y).toBeCloseTo(p.y, 8);
    }
  });

  it('uses all points and reports residuals rather than forcing bad pairs to pass', () => {
    const map = measuredMap();
    map.calibration.points[3].x += 1000;
    const calibrated = applyCalibration(map);
    expect(fitCalibration(map)).not.toBeNull();
    const report = inspectCalibration(calibrated);
    expect(report.valid).toBe(false);
    expect(report.points.some(p => !p.valid)).toBe(true);
    expect(calibrated.calibration.points).toEqual(map.calibration.points);
  });

  it('accepts a well-spread fourth point even when the first three are collinear', () => {
    const map = measuredMap();
    map.calibration.points.splice(2, 0, {
      u: .5, v: .1, x: -3100 + .5 * 1024 * 3.75,
      y: 4200 - .1 * 1024 * 3.75, floorId: 'main',
    });
    expect(hasCalibrationSpread(map.calibration.points.slice(0, 3))).toBe(false);
    expect(inspectCalibration(applyCalibration(map)).valid).toBe(true);
    const reversed = structuredClone(map);
    reversed.calibration.points.reverse();
    expect(fitCalibration(reversed)!.scale).toBeCloseTo(fitCalibration(map)!.scale, 12);
  });

  it('requires independent references for every floor while fitting one shared transform', () => {
    const map = measuredMap();
    map.floors.push({ id: 'lower', name: 'Lower', radarUrl: '/lower.webp' });
    expect(inspectCalibration(applyCalibration(map)).valid).toBe(false);
    map.calibration.points.push(...map.calibration.points.map(p => ({ ...p, floorId: 'lower' })));
    expect(inspectCalibration(applyCalibration(map)).valid).toBe(true);
    map.calibration.points[4].x += 300;
    expect(inspectCalibration(applyCalibration(map)).valid).toBe(false);
  });

  it('does not invent a fit from insufficient, collinear or clustered points', () => {
    const map = measuredMap();
    map.calibration.points = map.calibration.points.slice(0, 2);
    expect(fitCalibration(map)).toBeNull();
    expect(inspectCalibration(map).valid).toBe(false);
    map.calibration.points.push({ ...map.calibration.points[0], u: .5 });
    expect(fitCalibration(map)).toBeNull();
    map.calibration.points[2].v += .001;
    expect(fitCalibration(map)).toBeNull();
  });

  it('rejects unknown floors, non-finite data, zero world spread and reversed axes', () => {
    for (const mutate of [
      (m: MapDefinition) => { m.calibration.points[0].floorId = 'unknown'; },
      (m: MapDefinition) => { m.calibration.points[0].x = Infinity; },
      (m: MapDefinition) => { m.calibration.points[0].u = -1; },
      (m: MapDefinition) => { m.calibration.points.forEach(p => { p.x = 1; p.y = 1; }); },
      (m: MapDefinition) => { m.calibration.points.forEach(p => { p.x *= -1; p.y *= -1; }); },
    ]) {
      const map = measuredMap();
      mutate(map);
      expect(fitCalibration(map)).toBeNull();
      expect(inspectCalibration(map).valid).toBe(false);
    }
  });

  it('fits the four measured Dust2 references without moving any reference pin', () => {
    const map = measuredMap();
    map.calibration = {
      posX: -2476, posY: 3239, scale: 4.4,
      points: [
        { x: -2093.970947, y: 3117.937256, u: 0.07755696553860193, v: 0.016809391856873197, floorId: 'main' },
        { x: 439.683258, y: -999.954224, u: 0.6502856861275725, v: 0.9419926391557827, floorId: 'main' },
        { x: -2203.814453, y: -1031.971313, u: 0.05620693160847023, v: 0.9471684945398947, floorId: 'main' },
        { x: 1561.96875, y: 3059.968262, u: 0.9019908551349314, v: 0.03605270772985971, floorId: 'main' },
      ],
    };
    expect(inspectCalibration(map).valid).toBe(false);
    const fitted = applyCalibration(map);
    expect(fitted.calibration.points).toEqual(map.calibration.points);
    expect(inspectCalibration(fitted).valid).toBe(true);
    expect(Math.max(...inspectCalibration(fitted).points.map(p => p.error))).toBeLessThan(.005);
  });
});
