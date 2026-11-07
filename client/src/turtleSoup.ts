import type { AttributeFeedback, FeedbackLevel, PlayerInfo } from './types';

export const SOUP_MAX_ATTEMPTS = 24;
export const SOUP_FIELDS = ['team', 'nationality', 'role', 'isActive', 'age', 'majorChampionships', 'majorAppearances'] as const;
export type SoupField = typeof SOUP_FIELDS[number];
export type SoupEvent = { requestId: string; elapsedMs: number } & (
  | { type: 'question'; field: SoupField; value: string | number | boolean; level: FeedbackLevel; hint?: AttributeFeedback['hint'] }
  | { type: 'guess'; playerId: number; nickname: string; correct: boolean }
  | { type: 'giveup' }
);
export interface SoupGame {
  gameId: string; mode: string; variant: 'turtle-soup'; version: number;
  status: 'playing' | 'won' | 'lost'; maxQuestions: number; remainingQuestions: number;
  questionCount: number; guessCount: number; guessUnlocked: boolean;
  events: SoupEvent[]; answer?: PlayerInfo; recorded?: boolean;
}
export interface SoupOptions {
  teams: string[];
  countries: Array<{ nationality: string; region: string }>;
}
/**
 * Game protocol v2 response for one accepted write: the new event and counters
 * on top of version `base`. Replays and older servers answer with a full SoupGame.
 */
export interface SoupDelta {
  gameId: string; variant: 'turtle-soup'; base: number; version: number;
  status: SoupGame['status']; remainingQuestions: number; questionCount: number; guessCount: number;
  guessUnlocked: boolean; event: SoupEvent; answer?: PlayerInfo; recorded?: boolean;
}
export type SoupResponse = SoupGame | SoupDelta;

/** Merge a write response; null when a delta does not follow the held version. */
export function mergeSoup(current: SoupGame, data: SoupResponse): SoupGame | null {
  if (!('base' in data)) return data;
  if (data.gameId !== current.gameId || data.base !== current.version) return null;
  return {
    ...current,
    version: data.version, status: data.status,
    remainingQuestions: data.remainingQuestions, questionCount: data.questionCount, guessCount: data.guessCount,
    guessUnlocked: data.guessUnlocked,
    events: [...current.events, data.event],
    ...(data.answer ? { answer: data.answer } : {}),
    ...(data.recorded !== undefined ? { recorded: data.recorded } : {}),
  };
}
