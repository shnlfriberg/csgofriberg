export type * from '@friberg/location-core';
import type { MapDefinition, RoomState as CoreRoomState, RoomView, RoundResult } from '@friberg/location-core';

/** Server room state: the shared core shape plus room-kernel bookkeeping. */
export interface RoomState extends CoreRoomState {
  /** Stable hash of `maps`, set when the game starts (room protocol v2). */
  mapsHash?: string | null;
  /** Identities with a page still on protocol v1 (opened before the upgrade). */
  v1Seats?: string[];
}

/**
 * 图寻 multiplayer protocol v2 on the room kernel. Compared with the full
 * RoomView it omits the map catalogue after the first view and replaces the two
 * MapDefinitions embedded in every round result by ids.
 */
export type CompactRoundResult = Omit<RoundResult, 'map' | 'guessedMap'>;

export interface CompactRoomResult {
  key: string;
  name: string;
  rounds: CompactRoundResult[];
}

export interface RoomViewV2 extends Omit<RoomView, 'maps' | 'results'> {
  protocol: 2;
  /** Present only when the client does not already hold this catalogue. */
  maps?: MapDefinition[];
  mapsHash: string | null;
  results: CompactRoomResult[];
}

/** Public sections of one committed revision (never another seat's guess). */
export interface RoomPatchSectionsV2 {
  status?: RoomView['status'];
  round?: number;
  startsAt?: number | null;
  endsAt?: number | null;
  nextAt?: number | null;
  question?: RoomView['question'];
  host?: string;
  players?: RoomView['players'];
  /** Rounds revealed in this revision, appended to each player's results. */
  resultsAppend?: Array<{ key: string; round: CompactRoundResult }>;
  maps?: MapDefinition[];
  mapsHash?: string | null;
  /** Every seat's private guess was reset (new round). */
  clearMyGuess?: true;
}
