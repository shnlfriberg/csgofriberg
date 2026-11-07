import { z } from 'zod';

/**
 * Server-side capability registry for room game modes.
 *
 * A mode is intentionally described as data here. Adding a future mode still
 * requires its gameplay handler, but its public contract and room constraints
 * have one owner instead of being repeated across routes and Redis recovery.
 */
export const ROOM_GAME_MODE_DEFINITIONS = {
  classic: {
    key: 'classic',
    labelKey: 'multi.classicMode',
    engine: 'player-guess',
    minPlayers: 2,
    maxPlayers: 8,
    totalRounds: 'bo',
    requiresTeams: false,
    cooperative: false,
    supportsSkipRound: true,
  },
  relay: {
    key: 'relay',
    labelKey: 'multi.relayMode',
    engine: 'player-guess',
    minPlayers: 2,
    maxPlayers: 4,
    totalRounds: 'configured',
    requiresTeams: false,
    cooperative: true,
    supportsSkipRound: false,
  },
  relay2v2: {
    key: 'relay2v2',
    labelKey: 'multi.relay2v2Mode',
    engine: 'player-guess',
    minPlayers: 4,
    maxPlayers: 4,
    totalRounds: 'configured',
    requiresTeams: true,
    cooperative: false,
    supportsSkipRound: true,
  },
} as const;

export type GameMode = keyof typeof ROOM_GAME_MODE_DEFINITIONS;
export type GameModeDefinition = (typeof ROOM_GAME_MODE_DEFINITIONS)[GameMode];

export const SINGLE_GAME_VARIANT_DEFINITIONS = {
  classic: {
    key: 'classic',
    engine: 'player-guess',
    target: 'player',
    difficultyScoped: true,
  },
  'turtle-soup': {
    key: 'turtle-soup',
    engine: 'attribute-question',
    target: 'player',
    difficultyScoped: true,
  },
} as const;

export type SingleGameVariant = keyof typeof SINGLE_GAME_VARIANT_DEFINITIONS;
export type SingleGameVariantDefinition =
  (typeof SINGLE_GAME_VARIANT_DEFINITIONS)[SingleGameVariant];

const gameModeKeys = Object.keys(ROOM_GAME_MODE_DEFINITIONS) as [GameMode, ...GameMode[]];
const singleGameVariantKeys = Object.keys(SINGLE_GAME_VARIANT_DEFINITIONS) as [
  SingleGameVariant,
  ...SingleGameVariant[],
];

export const roomGameModeSchema = z.enum(gameModeKeys);
export const singleGameVariantSchema = z.enum(singleGameVariantKeys);

export function isRoomGameMode(value: unknown): value is GameMode {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(ROOM_GAME_MODE_DEFINITIONS, value);
}

export function getRoomGameModeDefinition(value: unknown): GameModeDefinition {
  return isRoomGameMode(value)
    ? ROOM_GAME_MODE_DEFINITIONS[value]
    : ROOM_GAME_MODE_DEFINITIONS.classic;
}

export function listRoomGameModes() {
  return gameModeKeys.map((key) => {
    const definition = ROOM_GAME_MODE_DEFINITIONS[key];
    return {
      key: definition.key,
      labelKey: definition.labelKey,
      engine: definition.engine,
      players: {
        min: definition.minPlayers,
        max: definition.maxPlayers,
      },
      totalRounds: definition.totalRounds,
      capabilities: {
        requiresTeams: definition.requiresTeams,
        cooperative: definition.cooperative,
        supportsSkipRound: definition.supportsSkipRound,
      },
    };
  });
}

export function isSingleGameVariant(value: unknown): value is SingleGameVariant {
  return typeof value === 'string'
    && Object.prototype.hasOwnProperty.call(SINGLE_GAME_VARIANT_DEFINITIONS, value);
}

export function getSingleGameVariantDefinition(value: unknown): SingleGameVariantDefinition {
  return isSingleGameVariant(value)
    ? SINGLE_GAME_VARIANT_DEFINITIONS[value]
    : SINGLE_GAME_VARIANT_DEFINITIONS.classic;
}

export function listSingleGameVariants() {
  return singleGameVariantKeys.map((key) => SINGLE_GAME_VARIANT_DEFINITIONS[key]);
}

/**
 * Every single-player game served by `/api/game`. The player-target variants
 * above use the shared single-game store; the entertainment variants keep their
 * own authoritative storage behind an adapter (see services/soloGames.ts) but
 * share the same start/resume contract and routes.
 */
export const SOLO_GAME_VARIANT_DEFINITIONS = {
  ...SINGLE_GAME_VARIANT_DEFINITIONS,
  location: {
    key: 'location',
    engine: 'location-guess',
    target: 'location',
    difficultyScoped: true,
  },
  'card-link': {
    key: 'card-link',
    engine: 'card-chain',
    target: 'player-chain',
    difficultyScoped: true,
  },
} as const;

export type SoloGameVariant = keyof typeof SOLO_GAME_VARIANT_DEFINITIONS;

const soloGameVariantKeys = Object.keys(SOLO_GAME_VARIANT_DEFINITIONS) as [SoloGameVariant, ...SoloGameVariant[]];
export const soloGameVariantSchema = z.enum(soloGameVariantKeys);

export function listSoloGameVariants() {
  return soloGameVariantKeys.map((key) => SOLO_GAME_VARIANT_DEFINITIONS[key]);
}
