import { afterEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ set: vi.fn(async () => 'OK'), script: vi.fn(async () => 1) }));
vi.mock('../../src/redis', () => ({ redis: () => ({ set: mocks.set }), redisKey: (key: string) => key, evalCommandScript: mocks.script }));
import { withKeyLock } from '../../src/services/keyLock';

afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); });
describe('renewable distributed lease', () => {
  it('renews long work with its token and releases the lease afterwards', async () => {
    vi.useFakeTimers();
    let done!: () => void;
    const work = withKeyLock('lease-test', () => new Promise<void>(resolve => { done = resolve; }));
    await vi.advanceTimersByTimeAsync(16000);
    expect(mocks.script.mock.calls.filter((call: any[]) => call[0] === 'key-lock-renew-v1')).toHaveLength(3);
    done(); await work;
    expect(mocks.script).toHaveBeenLastCalledWith('key-lock-release-v1', expect.any(String), ['lock:lease-test'], [expect.any(String)]);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('preserves the original handler error and stops renewing', async () => {
    vi.useFakeTimers();
    await expect(withKeyLock('lease-failed', async () => { throw new Error('original'); })).rejects.toThrow('original');
    expect(vi.getTimerCount()).toBe(0);
  });
});
