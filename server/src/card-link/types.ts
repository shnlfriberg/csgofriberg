import type {
  Best,
  Difficulty,
  Question,
  RoundState,
  Scene,
  Variant,
} from "@friberg/card-link-core";
export interface Owner {
  key: string;
  userId: number | null;
  name: string;
}
export interface Match {
  id: string;
  code: string | null;
  host: string;
  scene: Scene;
  variant: Variant;
  difficulty: Difficulty;
  status:
    | "waiting"
    | "preparing"
    | "playing"
    | "roundOver"
    | "finished"
    | "cancelled";
  revision: number;
  round: number;
  questions: Question[];
  duration: number;
  dueAt: number | null;
  /** Solo inactivity expiry or the daily Shanghai midnight cutoff. */
  expiresAt?: number;
  day: string | null;
  /** Legacy field name: marks a daily retry. Retries now count toward daily best. */
  dailyPractice?: boolean;
  createdAt: number;
  rulesVersion: 1;
}
export interface Seat {
  owner: Owner;
  connected?: boolean;
  disconnectAt?: number | null;
  ready: boolean;
  retired: boolean;
  current: RoundState | null;
  results: (Best | null)[];
}
export interface SeatRow {
  match_id: string;
  identity_key: string;
  revision: number;
  payload: string;
}
