import { useEffect, useReducer } from 'react';

/**
 * Remaining whole seconds until `deadline` (server time = local time + offset).
 * Re-renders once per second, aligned to second boundaries, stops at zero and
 * pauses while the page is hidden. Replaces 250 ms polling intervals.
 */
export function useCountdown(deadline: number | null | undefined, offset = 0): number {
  const [, tick] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!deadline) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      const remainingMs = deadline - Date.now() - offset;
      if (remainingMs <= 0) return;
      const untilNextSecond = remainingMs % 1000 || 1000;
      timer = setTimeout(() => {
        tick();
        schedule();
      }, untilNextSecond + 5);
    };
    const onVisibility = () => {
      tick();
      schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [deadline, offset]);
  return deadline ? Math.max(0, Math.ceil((deadline - Date.now() - offset) / 1000)) : 0;
}

/**
 * Re-render once per second (aligned to the wall clock) while `active`;
 * paused while the page is hidden. For clocks that count up or down.
 */
export function useSecondTicker(active: boolean): number {
  const [, tick] = useReducer((value: number) => value + 1, 0);
  useEffect(() => {
    if (!active) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      timer = setTimeout(() => {
        tick();
        schedule();
      }, 1000 - (Date.now() % 1000) + 5);
    };
    const onVisibility = () => {
      tick();
      schedule();
    };
    schedule();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [active]);
  return Date.now();
}
