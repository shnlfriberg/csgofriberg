import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => {
  const listeners = new Map<string, (...args: any[]) => void>();
  const target = { connected: false, active: false, auth: {},
    on: vi.fn((event: string, listener: (...args: any[]) => void) => { listeners.set(event, listener); }),
    connect: vi.fn(), disconnect: vi.fn(),
  };
  target.connect.mockImplementation(() => { target.active = true; });
  target.disconnect.mockImplementation(() => { target.active = false; target.connected = false; });
  return { target, listeners, refresh: vi.fn(), guest: vi.fn() };
});
vi.mock('socket.io-client', () => ({ io: () => mocks.target }));
vi.mock('../../src/api/session', () => ({ ensureGuestSession: mocks.guest, hasAuthHint: () => true }));
vi.mock('../../src/api/authSession', () => ({ refreshAuthenticatedSession: mocks.refresh }));
vi.mock('../../src/i18n/messages', () => ({ translate: (value: string) => value }));
vi.mock('../../src/components/Toast', () => ({ toast: { dismiss: vi.fn(), error: vi.fn(), success: vi.fn() } }));
import { closeSocket, getSocket } from '../../src/api/socket';

beforeEach(() => {
  mocks.target.active = false; mocks.target.connected = false;
  mocks.target.connect.mockClear(); mocks.refresh.mockReset(); mocks.guest.mockReset().mockResolvedValue(undefined);
});
afterEach(() => { closeSocket(); });
describe('server-requested socket disconnection', () => {
  it.each([true, false])('restores a usable identity before reconnecting (refresh=%s)', async refreshed => {
    mocks.refresh.mockResolvedValue(refreshed);
    getSocket(); await vi.waitFor(() => expect(mocks.target.connect).toHaveBeenCalledTimes(1));
    mocks.target.active = false;
    mocks.listeners.get('disconnect')!('io server disconnect');
    await vi.waitFor(() => expect(mocks.target.connect).toHaveBeenCalledTimes(2));
    expect(mocks.refresh).toHaveBeenCalledOnce();
    if (refreshed) expect(mocks.guest).not.toHaveBeenCalled();
    else expect(mocks.guest).toHaveBeenCalledWith(true);
  });
  it('does not restore a session for a deliberate local disconnect', async () => {
    getSocket(); await vi.waitFor(() => expect(mocks.target.connect).toHaveBeenCalledOnce());
    mocks.listeners.get('disconnect')!('io client disconnect');
    expect(mocks.refresh).not.toHaveBeenCalled();
  });
});
