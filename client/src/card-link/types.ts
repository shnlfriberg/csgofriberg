import type {
  Best,
  CardPlayer,
  Difficulty,
  EdgeEvidence,
  PublicRound,
  Scene,
  Variant,
} from "@friberg/card-link-core";
export interface View {
  rematch?: { acceptedKeys: string[]; requiredKeys: string[]; nextId?: string };
  id: string;
  code: string | null;
  scene: Scene;
  variant: Variant;
  difficulty: Difficulty;
  status: string;
  phaseRevision: number;
  publicRevision: number;
  revision: number;
  round: number;
  rounds: number;
  duration: number;
  dueAt: number | null;
  expiresAt?: number;
  day: string | null;
  dailyPractice?: boolean;
  rulesVersion: number;
  graphVersion: string;
  me: string;
  host: boolean;
  question: { start: number; end: number } | null;
  current: PublicRound | null;
  players: {
    id: string;
    name: string;
    ready: boolean;
    retired: boolean;
    connected?: boolean;
    disconnectAt?: number | null;
    solved: boolean;
    locked: boolean;
    results: (Best | null)[];
  }[];
  solution: number[] | null;
  evidence: { a: number; b: number; evidence: EdgeEvidence[] }[];
  connections?: { a: number; b: number; evidence: EdgeEvidence[] }[];
}
export type Directory = CardPlayer[];
