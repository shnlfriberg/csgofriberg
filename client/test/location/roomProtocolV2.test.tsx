import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LocationMulti from '../../src/pages/LocationMulti';
import { useAuth } from '../../src/store/auth';
import { renderAtRoute } from '../render';
import { applyRoomPatchV2, hydrateRoomView, type RoomViewV2 } from '../../src/location/roomProtocol';
import type { MapDefinition, RoundResult } from '../../src/location/types';

const { roomAction, socket, handlers } = vi.hoisted(() => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const socket: any = {
    id: 'socket-v2',
    connected: true,
    on: vi.fn((event: string, handler: (...args: any[]) => void) => handlers.set(event, handler)),
    off: vi.fn((event: string) => handlers.delete(event)),
    emit: vi.fn(),
  };
  // Answers the room-kernel handshake with protocol v2.
  socket.timeout = () => ({ emit: (event: string, _payload: unknown, ack: (error: unknown, result: unknown) => void) => {
    if (event === 'room-kernel:hello') ack(null, { ok: true, protocols: { location: 2 }, serverNow: Date.now() });
  } });
  return { handlers, roomAction: vi.fn(), socket };
});
vi.mock('../../src/api/socket', () => ({ getSocket: () => socket }));
vi.mock('../../src/location/api', () => ({ roomAction, message: (e: any) => e.code }));

const map: MapDefinition = { id: 'm1', name: 'Map', enabled: true, order: 1, version: 1, width: 1000, height: 1000,
  bounds: { u: 0, v: 0, width: 1, height: 1 }, floors: [{ id: 'f', name: 'F', radarUrl: '/r.webp' }],
  calibration: { posX: 0, posY: 0, scale: 1, points: [] } };
const player = (key: string, name: string) => ({ key, name, ready: true, connected: true, retired: false, submitted: false, score: 0, rank: null });
const baseView = (): RoomViewV2 => ({ protocol: 2, mapsHash: 'h1', maps: [map], id: 'ROOM2', gameId: 'g', me: 'p:me', host: 'p:me', viewerUserId: null,
  difficulty: 'normal', duration: 60, status: 'playing', revision: 5, round: 1, question: { round: 1, imageUrl: '/q.webp' },
  serverNow: Date.now(), startsAt: null, endsAt: Date.now() + 60000, nextAt: null, myGuess: null,
  players: [player('p:me', 'Me'), player('p:other', 'Other')], results: [{ key: 'p:me', name: 'Me', rounds: [] }, { key: 'p:other', name: 'Other', rounds: [] }] });

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
  vi.clearAllMocks();
  handlers.clear();
  sessionStorage.clear();
  useAuth.setState({ user: null, initialized: true });
});

describe('图寻 room protocol v2 on the client', () => {
  it('rehydrates compact results with the cached maps without copying the catalogue', () => {
    const view = hydrateRoomView(baseView(), [map]);
    const round = { round: 1, imageUrl: '/q.webp', questionId: 'q', questionVersion: 1, tier: 'easy', guess: { mapId: 'm1', floorId: 'f', u: 0.1, v: 0.1 },
      answer: { mapId: 'm1', floorId: 'f', u: 0.1, v: 0.1 }, score: 5000, distanceRatio: 0, mapCorrect: true, floorCorrect: true } as Omit<RoundResult, 'map' | 'guessedMap'>;
    const next = applyRoomPatchV2(view, { game: 'location', roomId: 'ROOM2', base: 5, rev: 6, serverNow: Date.now(),
      sections: { status: 'round_over', resultsAppend: [{ key: 'p:me', round }, { key: 'p:other', round: { ...round, guess: null, score: 0 } }] } }, [map])!;
    expect(next.revision).toBe(6);
    expect(next.maps).toBe(view.maps);
    expect(next.results[0].rounds[0].map).toBe(map);
    expect(next.results[0].rounds[0].guessedMap).toBe(map);
    expect(next.results[1].rounds[0].guessedMap).toBeNull();
  });

  it('negotiates v2, applies public patches and the seat-private guess, and never refetches on contiguous revisions', async () => {
    sessionStorage.setItem('location:room:guest', 'ROOM2');
    roomAction.mockImplementation(async (event: string, payload: any) => {
      if (event === 'location:room:state') return baseView();
      throw { code: 'UNEXPECTED', event, payload };
    });
    renderAtRoute(<LocationMulti />);
    expect(await screen.findByText('ROOM2')).toBeInTheDocument();
    expect(roomAction).toHaveBeenCalledWith('location:room:state', { roomId: 'ROOM2' });
    expect(socket.emit).not.toHaveBeenCalledWith('location:room:delta', true);
    act(() => handlers.get('room-kernel:patch')!({ game: 'location', roomId: 'ROOM2', base: 5, rev: 6, serverNow: Date.now(),
      sections: { players: [{ ...player('p:me', 'Me'), submitted: true }, player('p:other', 'Other')] } }));
    act(() => handlers.get('room-kernel:private')!({ game: 'location', roomId: 'ROOM2', rev: 6, private: { myGuess: { mapId: 'm1', floorId: 'f', u: 0.5, v: 0.5 } } }));
    expect(await screen.findByText('答案已锁定，等待其他玩家或倒计时结束。')).toBeInTheDocument();
    expect(roomAction).toHaveBeenCalledTimes(1);
    // A gap triggers exactly one resynchronisation that sends the cached maps hash.
    act(() => handlers.get('room-kernel:patch')!({ game: 'location', roomId: 'ROOM2', base: 8, rev: 9, serverNow: Date.now(), sections: {} }));
    await waitFor(() => expect(roomAction).toHaveBeenCalledTimes(2));
    expect(roomAction).toHaveBeenLastCalledWith('location:room:state', { roomId: 'ROOM2', mapsHash: 'h1' });
  });
});
