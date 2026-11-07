import { StoredIdentity, StoredPlayer, getRoom } from '../services/roomStore';
import { redisKey } from '../redis';
import { allocateRoomCode, registerCodeNamespace } from '../rooms/kernel/codes';

registerCodeNamespace('classic', {
  redisKeys: (id) => [redisKey(`room:${id}`), redisKey(`room:${id}:meta`)],
  localExists: async (id) => Boolean(await getRoom(id)),
});

/** Room codes come from the kernel namespace shared with 图寻 rooms. */
export async function generateRoomId(): Promise<string> {
  return allocateRoomCode('classic');
}

export function makeRoomPlayer(
  identity: StoredIdentity,
  socketId: string,
  ready: boolean
): StoredPlayer {
  return {
    key: identity.key,
    userId: identity.userId,
    name: identity.name,
    socketId,
    ready,
    score: 0,
    guesses: [],
    guessTimes: [],
    lastGuessAt: null,
    skipped: false,
    connected: true,
    disconnectDeadline: null,
    eliminated: false,
    eliminationReason: null,
    team: null,
  };
}
