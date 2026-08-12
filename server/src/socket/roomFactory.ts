import { StoredIdentity, StoredPlayer, getRoom } from '../services/roomStore';

const ROOM_ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export async function generateRoomId(): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt++) {
    const id = Array.from(
      { length: 5 },
      () => ROOM_ID_CHARS[Math.floor(Math.random() * ROOM_ID_CHARS.length)]
    ).join('');
    if (!(await getRoom(id))) return id;
  }
  throw new Error('ROOM_ID_EXHAUSTED');
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
  };
}
