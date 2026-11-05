import { createHash } from 'crypto';
import type { MapDefinition, QuestionSnapshot, RoomState } from '../../src/location/types';

export function testMap(id = 'test_location'): MapDefinition {
  return { id, name: 'TEST ONLY', enabled: true, order: 99, version: 1, width: 1000, height: 500,
    bounds: { u: 0, v: 0, width: 1, height: 1 }, floors: [{ id: 'upper', name: 'Upper', radarUrl: '/location-radars/de_nuke_upper.webp' }, { id: 'lower', name: 'Lower', radarUrl: '/location-radars/de_nuke_lower.webp' }],
    calibration: { posX: 0, posY: 500, scale: 1, points: ['upper', 'lower'].flatMap(floorId => [{ u: .1, v: .1 }, { u: .8, v: .1 }, { u: .1, v: .8 }].map(p => ({ ...p, x: p.u * 1000, y: 500 - p.v * 500, floorId }))) } };
}
export function testPool(count = 60): QuestionSnapshot[] {
  return Array.from({ length: count }, (_, i) => ({ map: testMap(), question: { id: `test_location_${i}`, capturePointId: `point_${i}`, version: 1, mapVersion: 1, mapId: 'test_location', floorId: i % 2 ? 'lower' : 'upper', u: .2 + i / 200, v: .5, tier: (['easy', 'medium', 'hard'] as const)[i % 3], status: 'published', imageUrl: `/location-assets/00000000-0000-4000-8000-${String(i).padStart(12, '0')}.webp`, thumbnailUrl: `/location-assets/00000000-0000-4000-8000-${String(i).padStart(12, '0')}-thumb.webp`, imageHash: createHash('sha256').update(`TEST ONLY ${i}`).digest('hex'), capturedAt: '2026-01-01T00:00:00Z', build: 'TEST ONLY', source: 'Isolated automated fixture; never published as game content' } }));
}
export function testRoom(): RoomState {
  return { id: 'TEST1', gameId: 'test-game', host: 'g:a', difficulty: 'normal', duration: 120, status: 'playing', round: 1, questions: testPool().slice(0, 5), maps: [testMap()], startsAt: null, endsAt: Date.now() + 120000, nextAt: null, revision: 1, createdAt: Date.now(),
    players: ['a', 'b'].map(key => ({ identity: { key: `g:${key}`, userId: null, name: key }, socketId: key, connected: true, ready: true, retired: false, disconnectAt: null, guesses: [], currentGuess: null, requests: {} })) };
}
