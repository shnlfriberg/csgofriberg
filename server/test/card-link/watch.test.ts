import { describe, expect, it, vi } from 'vitest';
import type { Server } from 'socket.io';
import { setupCardSocket } from '../../src/card-link/socket';
import { seatId } from '../../src/card-link/views';
const mocks = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('../../src/card-link/matches', () => ({ readView: mocks.read, readSnapshot: async () => ({ m: { questions: [{ graphVersion: 'test' }] }, rows: [] }), advanceById: vi.fn() }));
vi.mock('../../src/card-link/graphs', () => ({ loadGraph: async () => ({}) }));
vi.mock('../../src/card-link/claims', () => ({ matchOwner: async (_id: string, owner: unknown) => owner }));
vi.mock('../../src/middleware/auth', () => ({ authenticateCookie: async () => ({ id: 1 }), getGuestFromCookie: vi.fn() }));
vi.mock('../../src/socket/connection', () => ({ socketAllowedWithIp: async () => true }));
vi.mock('../../src/services/pow', () => ({ getRequestPow: () => ({ difficulty: 100 }) }));
vi.mock('../../src/card-link/scheduler', () => ({ advanceDueMatches: async () => {} }));
vi.mock('../../src/card-link/settlement', () => ({ flushSettlements: async () => {} }));
vi.mock('../../src/card-link/buildJobs', () => ({ processBuilds: async () => {} }));

function session() {
  const handlers = new Map<string, (...args: any[]) => void>(), rooms = new Set<string>();
  const socket = { connected: true, data: { identity: { key: 'u:1', userId: 1, name: 'Player' }, cardChannel: null as string | null }, handshake: { headers: {} },
    on: (name: string, fn: (...args: any[]) => void) => handlers.set(name, fn),
    join: vi.fn(async (room: string) => { rooms.add(room); }), leave: vi.fn(async (room: string) => { rooms.delete(room); }) };
  const stop = setupCardSocket({ on: (_event: string, fn: (socket: unknown) => void) => fn(socket) } as unknown as Server);
  return { socket, rooms, stop, emit: (event: string, ...args: any[]) => handlers.get(event)!(...args) };
}
const first = 'a'.repeat(36), second = 'b'.repeat(36);
describe('card watch request ordering', () => {
  it('does not let a slow old subscription replace the latest room', async () => {
    let release!: () => void;
    mocks.read.mockImplementation(async (id: string) => {
      if (id === first) await new Promise<void>(done => { release = done; });
      return { id };
    });
    const s = session(), oldAck = vi.fn(), newAck = vi.fn();
    try {
      s.emit('card-link:watch', { id: first }, oldAck);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      s.emit('card-link:watch', { id: second }, newAck);
      await vi.waitFor(() => expect(newAck).toHaveBeenCalled());
      release(); await s.stop();
      expect([...s.rooms]).toEqual([`card-link:${second}:${seatId('u:1')}`]);
      expect(oldAck).toHaveBeenCalledTimes(1);
      expect(oldAck).toHaveBeenCalledWith({ ok: false, code: 'CARD_WATCH_SUPERSEDED' });
    } finally { release?.(); await s.stop(); }
  });
  it('removes a delayed join that completes after unwatch', async () => {
    mocks.read.mockImplementation(async (id: string) => ({ id }));
    const s = session(), ack = vi.fn();
    let release!: () => void;
    s.socket.join.mockImplementation(async room => { await new Promise<void>(done => { release = done; }); s.rooms.add(room); });
    try {
      s.emit('card-link:watch', { id: first }, ack);
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      s.emit('card-link:unwatch'); release(); await s.stop();
      expect(s.rooms.size).toBe(0);
      expect(ack).toHaveBeenCalledTimes(1);
      expect(ack).toHaveBeenCalledWith({ ok: false, code: 'CARD_WATCH_SUPERSEDED' });
    } finally { release?.(); await s.stop(); }
  });
});
