import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import {
  clearPlayerListCache,
  getPlayerList,
  subscribePlayerList,
} from './playerList';

vi.mock('./client', () => ({
  api: { get: vi.fn() },
}));

const get = vi.mocked(api.get);

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('playerList cache', () => {
  beforeEach(() => {
    clearPlayerListCache();
    localStorage.clear();
    get.mockReset();
  });

  it('returns stored players immediately and revalidates once in the background', async () => {
    const cached = [{ id: 1, nickname: 'cached' }];
    const updated = [{ id: 2, nickname: 'updated' }];
    localStorage.setItem('player-list-v1', JSON.stringify({ version: '1', players: cached }));
    const request = deferred<any>();
    get.mockReturnValue(request.promise);
    const listener = vi.fn();
    const unsubscribe = subscribePlayerList(listener);

    await expect(getPlayerList()).resolves.toEqual(cached);
    await expect(getPlayerList()).resolves.toEqual(cached);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenCalledWith('/players/list', expect.objectContaining({
      headers: { 'If-None-Match': '"players-1"' },
    }));
    expect(listener).not.toHaveBeenCalled();

    request.resolve({ status: 200, data: { version: '2', players: updated } });
    await vi.waitFor(() => expect(listener).toHaveBeenCalledWith(updated));
    await expect(getPlayerList()).resolves.toEqual(updated);

    unsubscribe();
  });
});
