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
