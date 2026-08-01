import { beforeEach, describe, expect, it, vi } from 'vitest';
import axios from 'axios';

const post = vi.fn();

vi.mock('axios', () => ({
  default: {
    create: vi.fn(() => ({ post })),
  },
}));

class MockWorker {
  static instances: MockWorker[] = [];

  onmessage: ((event: MessageEvent<{ nonce?: string; error?: string }>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly terminate = vi.fn();
  readonly postMessage = vi.fn(() => {
    queueMicrotask(() => {
      if (this.options?.type === 'module') {
        this.onerror?.({ message: 'WebAssembly i64 BigInt is unsupported' } as ErrorEvent);
      } else {
        this.onmessage?.({ data: { nonce: '37031' } } as MessageEvent<{ nonce: string }>);
      }
    });
  });

  constructor(
    readonly url: URL,
    readonly options?: WorkerOptions
  ) {
    MockWorker.instances.push(this);
  }
}

describe('PoW worker fallback', () => {
  beforeEach(() => {
    vi.resetModules();
    post.mockReset();
    MockWorker.instances = [];
    vi.stubGlobal('Worker', MockWorker);
  });

  it('verifies the nonce from the classic JavaScript worker when the WASM worker fails', async () => {
    post
      .mockResolvedValueOnce({
        data: {
          id: 'challenge-id',
          challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          difficulty: 16,
          algorithm: 'csgofriberg-pow-v1',
        },
      })
      .mockResolvedValueOnce({ data: { expiresAt: Date.now() + 30_000, expiresInMs: 30_000 } });

    const { ensurePow } = await import('./pow');
    await ensurePow();

    expect(MockWorker.instances).toHaveLength(2);
    expect(MockWorker.instances[0].options).toEqual({ type: 'module' });
    expect(MockWorker.instances[0].terminate).toHaveBeenCalledOnce();
    expect(MockWorker.instances[1].options).toBeUndefined();
    expect(post).toHaveBeenNthCalledWith(2, '/verify', { id: 'challenge-id', nonce: '37031' });
    expect(vi.mocked(axios.create)).toHaveBeenCalledWith({
      baseURL: '/api/pow',
      withCredentials: true,
    });
  });

  it('requests the stronger register profile and exposes a fake progress state', async () => {
    post
      .mockResolvedValueOnce({
        data: {
          id: 'register-challenge-id',
          challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
          difficulty: 19,
          algorithm: 'csgofriberg-pow-v1',
        },
      })
      .mockResolvedValueOnce({ data: { expiresAt: Date.now() + 30_000, expiresInMs: 30_000, difficulty: 19 } });

    const { ensurePow, getPowProgress, subscribePowProgress } = await import('./pow');
    const states: boolean[] = [];
    const unsubscribe = subscribePowProgress(() => states.push(getPowProgress().active));
    await ensurePow({ profile: 'register' });
    unsubscribe();

    expect(states).toContain(true);
    expect(getPowProgress().active).toBe(false);
    expect(post).toHaveBeenNthCalledWith(1, '/challenge', { profile: 'register' }, expect.any(Object));
  });
});
