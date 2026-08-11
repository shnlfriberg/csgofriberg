import { logTransientError } from '../services/transientLog';

const timers = new Map<string, NodeJS.Timeout>();

export function setLocalTimer(
  key: string,
  delay: number,
  handler: () => void | Promise<unknown>
): void {
  const old = timers.get(key);
  if (old) clearTimeout(old);
  const timer = setTimeout(() => {
    timers.delete(key);
    void Promise.resolve()
      .then(handler)
      .catch((err) => logTransientError(`[timer:${key.split(':', 1)[0]}]`, err));
  }, Math.max(0, delay));
  timer.unref?.();
  timers.set(key, timer);
}

export function cancelLocalTimer(key: string): void {
  const timer = timers.get(key);
  if (timer) clearTimeout(timer);
  timers.delete(key);
}
