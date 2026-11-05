import type { Match, SeatRow } from './types';
import { seatId } from './views';

export const CARD_DISCONNECT_MS = 30_000;
export const CARD_PRESENCE_INTERVAL_MS = 2_000;
export const cardChannel = (id: string, key: string) => `card-link:${id}:${seatId(key)}`;
type Reader = (match: Match, rows: SeatRow[]) => Promise<Set<string>>;
let reader: Reader | null = null;
// The shared Socket.IO adapter supplies cluster-wide membership. A failed read
// must reject, never masquerade as an empty room and forfeit every player.
export function setCardPresenceReader(next: Reader | null) { reader = next; }
export function onlineCardPlayers(match: Match, rows: SeatRow[]) {
  return reader ? reader(match, rows) : Promise.resolve(null);
}
