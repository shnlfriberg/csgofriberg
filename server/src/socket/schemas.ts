import { z } from 'zod';
import {
  DEFAULT_ROOM_GUESS_INTERVAL_MS,
  DEFAULT_ROOM_MAX_GUESSES,
  MAX_ROOM_GUESS_INTERVAL_MS,
  MAX_ROOM_MAX_GUESSES,
  MAX_CLASSIC_ROOM_PLAYERS,
  MIN_ROOM_GUESS_INTERVAL_MS,
  MIN_ROOM_MAX_GUESSES,
  MIN_CLASSIC_ROOM_PLAYERS,
} from '../services/roomStore';

const difficultyKeySchema = z.string().trim().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/);

export const roomPlayerStatsPayloadSchema = z.object({
  playerKey: z.string().min(1).max(256),
});

export const roomCreatePayloadSchema = z.object({
  dbType: difficultyKeySchema,
  gameMode: z.enum(['classic', 'relay']).default('classic'),
  boType: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]).default(3),
  totalRounds: z.union([z.literal(1), z.literal(3), z.literal(5), z.literal(7)]).default(3),
  maxPlayers: z.number().int().min(MIN_CLASSIC_ROOM_PLAYERS).max(MAX_CLASSIC_ROOM_PLAYERS).default(2),
  allowSpectators: z.boolean().default(false),
  verifiedOnly: z.boolean().default(false),
  anonymous: z.boolean().default(false),
  maxGuesses: z.number().int().min(MIN_ROOM_MAX_GUESSES).max(MAX_ROOM_MAX_GUESSES)
    .default(DEFAULT_ROOM_MAX_GUESSES),
  guessIntervalMs: z.number().int()
    .min(MIN_ROOM_GUESS_INTERVAL_MS)
    .max(MAX_ROOM_GUESS_INTERVAL_MS)
    .default(DEFAULT_ROOM_GUESS_INTERVAL_MS),
});

export const roomJoinPayloadSchema = z.object({
  roomId: z.string().trim().toUpperCase().regex(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{5}$/),
  spectate: z.boolean().default(false),
});

export const rematchResponsePayloadSchema = z.object({ accept: z.boolean() });

export const roomReadyPayloadSchema = z.object({ ready: z.boolean().optional() }).default({});

export const matchReportPayloadSchema = z.object({
  description: z.string().trim().max(50).default(''),
});

export const gameGuessPayloadSchema = z.object({
  playerId: z.number().int().positive(),
  roundId: z.number().int().nonnegative(),
  eventId: z.string().regex(/^[\w-]{16,80}$/),
});

export const activeRoundPayloadSchema = z.object({
  roundId: z.number().int().positive(),
});

export const matchStartPayloadSchema = z.object({
  dbType: difficultyKeySchema,
  anonymous: z.boolean().default(false),
});
