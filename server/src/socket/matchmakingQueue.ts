import { DbType, QueuedIdentity } from '../services/roomStore';

const localQueue = new Map<string, QueuedIdentity[]>();

export function queueOrTakeLocalOpponent(
  dbType: DbType,
  queuedIdentity: QueuedIdentity
): QueuedIdentity | null {
  const queueKey = `${queuedIdentity.matchmakingPool}:${dbType}`;
  const queue = localQueue.get(queueKey) ?? [];
  if (queuedIdentity.matchmakingPool === 'restricted') {
    localQueue.set(
      queueKey,
      [...queue.filter((item) => item.key !== queuedIdentity.key), queuedIdentity]
    );
    return null;
  }

  const opponent = queue.find((item) => item.key !== queuedIdentity.key) ?? null;
  if (opponent) {
    localQueue.set(queueKey, queue.filter((item) => item.key !== opponent.key));
    return opponent;
  }
  localQueue.set(
    queueKey,
    [...queue.filter((item) => item.key !== queuedIdentity.key), queuedIdentity]
  );
  return null;
}

export function cancelLocalMatchmaking(identity: string, socketId?: string): void {
  for (const [key, queue] of localQueue) {
    localQueue.set(key, queue.filter((item) => (
      item.key !== identity || (socketId !== undefined && item.socketId !== socketId)
    )));
  }
}
