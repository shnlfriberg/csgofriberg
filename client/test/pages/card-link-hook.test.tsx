import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCardGame } from "../../src/card-link/useCardGame";
import { useAuth } from "../../src/store/auth";
import type { View } from "../../src/card-link/types";

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  pow: vi.fn(), auth: vi.fn(),
  socket: { connected: false, on: vi.fn(), off: vi.fn(), emit: vi.fn(), timeout: vi.fn(), disconnect: vi.fn(), connect: vi.fn() },
}));
vi.mock('../../src/api/pow', () => ({ ensurePow: mocks.pow }));
vi.mock('../../src/api/authSession', () => ({ refreshAuthenticatedSession: mocks.auth }));
vi.mock("../../src/api/client", () => ({
  api: mocks,
  errMsg: () => "request failed",
}));
vi.mock("../../src/api/socket", () => ({ getSocket: () => mocks.socket }));
const snapshot = (id: string, revision = 0) =>
  ({
    id,
    revision,
    phaseRevision: 1,
    publicRevision: revision,
    players: [],
    current: { board: [], hand: [1] },
  }) as unknown as View;
beforeEach(() => {
  vi.clearAllMocks();
  mocks.socket.connected = false;
  mocks.socket.emit.mockReset();
  mocks.socket.timeout.mockReturnValue(mocks.socket);
  mocks.socket.disconnect.mockReturnValue(mocks.socket);
  mocks.socket.connect.mockReturnValue(mocks.socket);
  mocks.pow.mockReset().mockResolvedValue(undefined);
  mocks.auth.mockReset().mockResolvedValue(true);
  sessionStorage.clear();
  useAuth.setState({ user: null, initialized: true });
  mocks.get.mockImplementation(async (url: string) => ({
    data: url.endsWith("/directory")
      ? { players: [] }
      : snapshot(url.split("/").pop()!),
  }));
});
afterEach(() => { vi.useRealTimers(); });
describe("card command recovery", () => {
  it('refreshes an expired session, reconnects and resubscribes without any socket PoW step', async () => {
    mocks.socket.connected = true;
    mocks.auth.mockResolvedValue(true);
    let watches = 0;
    mocks.socket.emit.mockImplementation((event, _body, ack) => {
      if (event === 'card-link:watch') ack(null, ++watches === 1
        ? { ok: false, code: 'AUTH_EXPIRED' } : { ok: true, data: snapshot('a', 2) });
    });
    const hook = renderHook(() => useCardGame('a'));
    await waitFor(() => expect(mocks.socket.connect).toHaveBeenCalledTimes(1));
    expect(mocks.auth).toHaveBeenCalled();
    expect(mocks.pow).not.toHaveBeenCalled();
    const onConnect = mocks.socket.on.mock.calls.find(([name]) => name === 'connect')![1];
    await act(async () => onConnect());
    await waitFor(() => expect(hook.result.current.realtimeReady).toBe(true));
    expect(hook.result.current.view?.revision).toBe(2);
    expect(hook.result.current.connectionError).toBe('');
    hook.unmount();
  });
  it('bounds failed subscription retries and offers a manual retry after timeout', async () => {
    vi.useFakeTimers();
    mocks.socket.connected = true;
    mocks.socket.emit.mockImplementation((event, _body, ack) => {
      if (event === 'card-link:watch') ack(new Error('timeout'));
    });
    const hook = renderHook(() => useCardGame('a'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10000); });
    expect(mocks.socket.emit.mock.calls.filter(([event]) => event === 'card-link:watch')).toHaveLength(4);
    expect(hook.result.current.connectionError).toBe('request failed');
    mocks.socket.emit.mockImplementation((event, _body, ack) => {
      if (event === 'card-link:watch') ack(null, { ok: true, data: snapshot('a') });
    });
    await act(async () => hook.result.current.retryConnection());
    expect(hook.result.current.realtimeReady).toBe(true);
    hook.unmount();
  });
  it('does not reconnect or apply an old subscription after changing games', async () => {
    mocks.socket.connected = true;
    let oldAck!: (error: unknown, result: unknown) => void;
    mocks.socket.emit.mockImplementation((event, body, ack) => {
      if (event !== 'card-link:watch') return;
      if (body.id === 'a') oldAck = ack;
      else ack(null, { ok: true, data: snapshot('b') });
    });
    const hook = renderHook(({ id }) => useCardGame(id), { initialProps: { id: 'a' } });
    await waitFor(() => expect(oldAck).toBeTypeOf('function'));
    hook.rerender({ id: 'b' });
    await waitFor(() => expect(hook.result.current.realtimeReady).toBe(true));
    await act(async () => oldAck(null, { ok: false, code: 'AUTH_EXPIRED' }));
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.socket.disconnect).not.toHaveBeenCalled();
    expect(hook.result.current.view?.id).toBe('b');
    hook.unmount();
  });
  it('clears a stale rejection when authoritative reload repairs the hand', async () => {
    const hook = renderHook(() => useCardGame('repair'));
    await waitFor(() => expect(hook.result.current.view?.id).toBe('repair'));
    mocks.post.mockRejectedValue({ response: { status: 409 } });
    mocks.get.mockResolvedValue({ data: { ...snapshot('repair', 1), current: { hand: [2], board: [], refreshes: 1, token: 0 } } });
    await act(() => hook.result.current.send({ type: 'play', playerId: 1, index: 0 }));
    expect(hook.result.current.error).toBe('');
    expect(hook.result.current.view?.current?.refreshes).toBe(1);
    expect(hook.result.current.pending).toBeNull();
  });
  it("retries a lost response using the exact persisted request rather than spending twice", async () => {
    mocks.post
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({ data: snapshot("a", 1) });
    const first = renderHook(() => useCardGame("a"));
    await waitFor(() => expect(first.result.current.view?.id).toBe("a"));
    await act(() =>
      first.result.current.send({ type: "play", playerId: 1, index: 0 }),
    );
    const input = mocks.post.mock.calls[0][1];
    expect(first.result.current.pending?.requestId).toBe(input.requestId);
    first.unmount();
    const restored = renderHook(() => useCardGame("a"));
    await waitFor(() => expect(restored.result.current.view?.id).toBe("a"));
    await act(() => restored.result.current.send());
    expect(mocks.post.mock.calls[1][1]).toEqual(input);
    expect(restored.result.current.pending).toBeNull();
    expect(sessionStorage.getItem("card-pending:null:a")).toBeNull();
  });
  it("does not block a new game or apply an old response across a context change", async () => {
    let finishOld!: (value: unknown) => void;
    mocks.post
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finishOld = resolve;
          }),
      )
      .mockResolvedValueOnce({ data: snapshot("b", 1) });
    const hook = renderHook(({ id }) => useCardGame(id), {
      initialProps: { id: "a" },
    });
    await waitFor(() => expect(hook.result.current.view?.id).toBe("a"));
    let oldRequest!: Promise<void>;
    act(() => {
      oldRequest = hook.result.current.send({
        type: "play",
        playerId: 1,
        index: 0,
      });
    });
    hook.rerender({ id: "b" });
    await waitFor(() => expect(hook.result.current.view?.id).toBe("b"));
    await act(() =>
      hook.result.current.send({ type: "play", playerId: 1, index: 0 }),
    );
    expect(mocks.post).toHaveBeenCalledTimes(2);
    await act(async () => {
      finishOld({ data: snapshot("a", 99) });
      await oldRequest;
    });
    expect(hook.result.current.view).toEqual(snapshot("b", 1));
    expect(hook.result.current.busy).toBe(false);
  });
});
