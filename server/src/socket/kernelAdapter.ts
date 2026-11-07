import type { GameRoomAdapter } from '../rooms/kernel/registry';
import { cancelQueue, getRoom } from '../services/roomStore';

/**
 * Classic guessing rooms on the shared room kernel. Classic keeps its own
 * storage, Lua scripts and socket-bound seats (`custom` presence); the kernel
 * uses this adapter for site-wide occupancy checks and queue exclusivity.
 */
export const classicRoomAdapter: GameRoomAdapter = {
  game: 'classic',
  presence: 'custom',
  async isActiveMember(roomId, identityKey) {
    const room = await getRoom(roomId);
    if (!room || room.status === 'finished') return false;
    if (room.players.some((player) => player.key === identityKey && !player.eliminated)) return 'player';
    if (room.spectators.some((spectator) => spectator.key === identityKey)) return 'spectator';
    return false;
  },
  async describe(roomId) {
    const room = await getRoom(roomId);
    return room ? { status: room.status, round: room.round, code: room.id } : null;
  },
  cancelQueue: (identityKey) => cancelQueue(identityKey),
};
