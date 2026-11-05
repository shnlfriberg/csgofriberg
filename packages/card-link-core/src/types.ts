export type Variant = "unlimited" | "limited";
export type Scene = "practice" | "daily" | "friend" | "ranked";
export type Difficulty = "easy" | "normal" | "hard";
export interface CardPlayer {
  id: number;
  nickname: string;
  age?: number | null;
  aliases: string[];
  nationality: string;
  team: string;
  /** Display-only honour from the current player catalog, not graph evidence. */
  majorChampion?: boolean;
}
export interface EdgeEvidence {
  team: string;
  start: string;
  end: string;
  sources: string[];
}
export interface GraphData {
  version: string;
  players: CardPlayer[];
  edges: { a: number; b: number; evidence: EdgeEvidence[] }[];
  pairs: Record<Difficulty, [number, number][]>;
}
export interface Question {
  graphVersion: string;
  start: number;
  end: number;
  pool: number[];
}
export interface Best {
  path: number[];
  elapsed: number;
}
export interface RoundState {
  board: number[];
  hand: number[];
  deck: number[];
  discarded: number[];
  token: 0 | 1 | 2;
  best: Best | null;
  locked: boolean;
  exhausted: boolean;
  refreshes: number;
  rng: number;
  startedAt: number;
  /** Frozen when this seat stops playing; absent in legacy stored rounds. */
  stoppedAt?: number;
  deadline: number | null;
}
export type Command =
  | { type: "play"; playerId: number; index: number }
  | { type: "remove"; playerId: number }
  | { type: "reorder"; board: number[] }
  | { type: "swap"; playerId: number }
  | { type: "refresh" }
  | { type: "lock" };
export interface PublicRound {
  board: number[];
  hand: number[];
  remaining: number;
  discarded: number[];
  token: 0 | 1 | 2;
  best: Best | null;
  locked: boolean;
  exhausted: boolean;
  refreshes: number;
  startedAt: number;
  stoppedAt?: number;
  deadline: number | null;
  links: boolean[];
}
export const RULES = Object.freeze({
  version: 1,
  handSize: 7,
  maxTokens: 2,
  seconds: 180,
  rounds: 3,
  eloInitial: 1000,
  eloK: 32,
});
export class RuleError extends Error {
  constructor(public code: string) {
    super(code);
  }
}
