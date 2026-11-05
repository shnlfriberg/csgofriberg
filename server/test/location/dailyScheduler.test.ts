import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ensureDaily } from '../../src/location/games';
import { startLocationDailyScheduler } from '../../src/location/dailyScheduler';
import { dayWindow } from '../../src/location/rules';
import { HttpError } from '../../src/middleware/common';

vi.mock('../../src/location/games', () => ({ ensureDaily: vi.fn() }));

describe('location daily deck scheduler', () => {
  const stops: Array<() => Promise<void>> = [];
  const start = () => {
    const stop = startLocationDailyScheduler();
    stops.push(stop);
    return stop;
  };
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-19T15:59:59Z'));
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.mocked(ensureDaily).mockReset().mockImplementation(async (now = Date.now()) => ({
      date: dayWindow(now).date,
      decks: { easy: [], normal: [], hard: [] },
      maps: [],
      scoringVersion: 1,
    }));
  });
  afterEach(async () => {
    await Promise.all(stops.splice(0).map((stop) => stop()));
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('catches up today on startup without waiting for players or an administrator', async () => {
    vi.setSystemTime(new Date('2026-10-19T02:00:00Z'));
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(ensureDaily).toHaveBeenCalledTimes(1);
    expect(ensureDaily).toHaveBeenCalledWith(Date.parse('2026-10-19T02:00:00Z'));
    expect(vi.getTimerCount()).toBe(1);
  });

  it('generates at Shanghai midnight every day and leaves today fixed between midnights', async () => {
    start();
    await vi.advanceTimersByTimeAsync(999);
    expect(ensureDaily).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ensureDaily).toHaveBeenLastCalledWith(Date.parse('2026-10-19T16:00:00Z'));
    expect(ensureDaily).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(86400_000 - 1);
    expect(ensureDaily).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(ensureDaily).toHaveBeenLastCalledWith(Date.parse('2026-10-20T16:00:00Z'));
    expect(ensureDaily).toHaveBeenCalledTimes(3);
  });

  it('retries insufficient material every minute and resumes midnight scheduling after recovery', async () => {
    vi.setSystemTime(new Date('2026-10-19T02:00:00Z'));
    vi.mocked(ensureDaily)
      .mockRejectedValueOnce(new HttpError(409, 'LOCATION_POOL_INSUFFICIENT'))
      .mockRejectedValueOnce(new HttpError(409, 'LOCATION_POOL_INSUFFICIENT'));
    start();
    await vi.advanceTimersByTimeAsync(60_000 - 1);
    expect(ensureDaily).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ensureDaily).toHaveBeenCalledTimes(2);
    expect(console.error).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ensureDaily).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(ensureDaily).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('retries transient failures at midnight even when the retry delay has not elapsed', async () => {
    vi.setSystemTime(new Date('2026-10-19T15:59:30Z'));
    vi.mocked(ensureDaily).mockRejectedValueOnce(new Error('DATABASE_UNAVAILABLE'));
    start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(ensureDaily).toHaveBeenCalledTimes(2);
    expect(ensureDaily).toHaveBeenLastCalledWith(Date.parse('2026-10-19T16:00:00Z'));
  });

  it('catches up the new day if an in-flight generation crosses midnight', async () => {
    let finish!: (value: Awaited<ReturnType<typeof ensureDaily>>) => void;
    vi.mocked(ensureDaily).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(ensureDaily).toHaveBeenCalledTimes(1);
    finish({ date: '2026-10-19', decks: { easy: [], normal: [], hard: [] }, maps: [], scoringVersion: 1 });
    await vi.advanceTimersByTimeAsync(1);
    expect(ensureDaily).toHaveBeenCalledTimes(2);
    expect(dayWindow(vi.mocked(ensureDaily).mock.calls[1][0]).date).toBe('2026-10-20');
  });

  it('waits for pending work on shutdown and cancels future generations', async () => {
    let finish!: () => void;
    vi.mocked(ensureDaily).mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { date: '2026-10-19', decks: { easy: [], normal: [], hard: [] }, maps: [], scoringVersion: 1 };
    });
    const stop = start();
    let stopped = false;
    const done = stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await done;
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(2 * 86400_000);
    expect(ensureDaily).toHaveBeenCalledTimes(1);
  });
});
