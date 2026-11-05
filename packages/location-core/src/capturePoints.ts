import type { CaptureDraft, CaptureImage, Question } from './types.js';

// Legacy single-image points remain readable without rewriting old archives.
export function captureImages(point: CaptureDraft): CaptureImage[] {
  return [
    ...(point.asset ? [{ id: point.id, asset: point.asset, createdAt: point.createdAt }] : []),
    ...(point.images || []),
  ];
}

export function sameCapturePoint(
  a: Pick<Question, 'mapId' | 'capturePointId'>,
  b: Pick<Question, 'mapId' | 'capturePointId'>
) {
  return a.mapId === b.mapId && a.capturePointId === b.capturePointId;
}

export function sameWorldPosition(
  a: NonNullable<Question['world']>,
  b: NonNullable<Question['world']>
) {
  // Allow console rounding; all persisted answers still use the canonical value.
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) <= 0.1;
}
