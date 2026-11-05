import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../src/redis', () => ({ redis: () => null }));
import { config } from '../../src/config';
import { withKeyLock } from '../../src/services/keyLock';
import { readState, writeState, deleteState, saveGame } from '../../src/location/store';

const previous = config.redisRequired;
afterEach(() => { config.redisRequired = previous; });
it('fails closed before invoking handlers or writing daily SQL when Redis is required', async () => {
  config.redisRequired = true;
  const handler = vi.fn();
  await expect(withKeyLock('required', handler)).rejects.toThrow('REDIS_UNAVAILABLE');
  expect(handler).not.toHaveBeenCalled();
  await expect(readState('required')).rejects.toThrow('REDIS_UNAVAILABLE');
  await expect(writeState('required', 1)).rejects.toThrow('REDIS_UNAVAILABLE');
  await expect(deleteState('required')).rejects.toThrow('REDIS_UNAVAILABLE');
  await expect(saveGame({ mode: 'daily' } as any)).rejects.toThrow('REDIS_UNAVAILABLE');
  config.redisRequired = false;
  expect(await readState('required')).toBeNull();
});
it('retains explicitly optional single-instance fallback', async () => {
  config.redisRequired = false;
  await withKeyLock('optional', () => writeState('optional', { value: 42 }));
  expect(await readState('optional')).toEqual({ value: 42 });
  await deleteState('optional');
  expect(await readState('optional')).toBeNull();
});
