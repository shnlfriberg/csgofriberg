import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import {
  clearPlayerListCache,
  getPlayerList,
  searchPlayerList,
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

  it('matches leet nicknames while keeping direct matches ahead of equivalents', () => {
    const players = [
      { id: 1, nickname: 's1mple' },
      { id: 2, nickname: 'simplex' },
      { id: 3, nickname: 'B1t' },
      { id: 4, nickname: 'bitwise' },
      { id: 5, nickname: 'f0rest' },
    ];

    expect(searchPlayerList(players, 'simple').map((player) => player.nickname))
      .toEqual(['s1mple', 'simplex']);
    expect(searchPlayerList(players, 'bit').map((player) => player.nickname))
      .toEqual(['B1t', 'bitwise']);
    expect(searchPlayerList(players, 'forest').map((player) => player.nickname))
      .toEqual(['f0rest']);
  });
});
