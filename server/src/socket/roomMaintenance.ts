import { deleteRoom, getRoom } from '../services/roomStore';

export async function cleanupRoom(roomId: string): Promise<void> {
  const room = await getRoom(roomId);
  if (room?.status === 'finished') await deleteRoom(room);
}
