import { randomUUID } from 'crypto';
import { hostname } from 'os';
import { logTransientError } from '../../services/transientLog';
import { kernelKey, kernelRedis } from './state';

/** One id per process; shared with the location metrics endpoint. */
export const instanceId = `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`;
export const instanceStartedAt = new Date().toISOString();

export const INSTANCE_TTL_MS = 15_000;
const HEARTBEAT_MS = 3_000;

export const instanceAliveKey = (id: string) => kernelKey(`kernel:instance:${id}`);
export const instancesKey = () => kernelKey('kernel:instances');

type MissingListener = () => Promise<void> | void;

/**
 * Publish this process as alive. Presence entries record the instance that
 * owns the socket; when this key expires the reaper detaches them, so a crashed
 * process is noticed within roughly INSTANCE_TTL_MS without cluster RPCs.
 */
export function startInstanceHeartbeat(onRecovered?: MissingListener): () => Promise<void> {
  let running: Promise<void> | null = null;
  let stopped = false;
  let registered = false;
  const beat = async () => {
    const client = kernelRedis();
    if (!client) return;
    const result = await client.multi()
      .set(instanceAliveKey(instanceId), instanceStartedAt, { PX: INSTANCE_TTL_MS, GET: true })
      .zAdd(instancesKey(), { score: Date.now(), value: instanceId })
      .exec();
    const previous = result?.[0] as unknown as string | null;
    // A long pause can let the key expire and the reaper drop our sockets.
    if (registered && previous === null && onRecovered) await onRecovered();
    registered = true;
  };
  const tick = () => {
    if (running || stopped) return;
    running = beat().catch((err) => logTransientError('[room-kernel:instance]', err)).finally(() => {
      running = null;
    });
  };
  tick();
  const timer = setInterval(tick, HEARTBEAT_MS);
  timer.unref?.();
  return async () => {
    stopped = true;
    clearInterval(timer);
    await running;
    const client = kernelRedis();
    if (!client) return;
    await client.multi().del(instanceAliveKey(instanceId)).zRem(instancesKey(), instanceId).exec()
      .catch((err) => logTransientError('[room-kernel:instance-stop]', err));
  };
}
