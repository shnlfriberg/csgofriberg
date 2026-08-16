import { Server, Socket } from 'socket.io';
import { guestNameFromKey, userNameFromUsername } from '../middleware/auth';
import { compareGuess, refreshGuessFeedback } from '../services/gameService';
import { getPlayer } from '../services/playerCache';
import { StoredIdentity, StoredRoom } from '../services/roomStore';
import { GuessFeedback, Player } from '../types';
import { winsNeeded } from './roomRules';

export function identityChannel(key: string): string {
  return `identity:${key}`;
}

export function spectatorChannel(roomId: string): string {
  return `room:${roomId}:spectators`;
}

export function joinRoomChannels(socket: Socket, room: StoredRoom, identity: string): void {
  socket.join(room.id);
  if (room.spectators.some((spectator) => spectator.key === identity)) {
    socket.join(spectatorChannel(room.id));
  } else {
    socket.leave(spectatorChannel(room.id));
  }
}

export function visibleGuess(feedback: GuessFeedback) {
  const { region: _region, ...attributes } = feedback.attributes;
  return { ...feedback, attributes };
}

export function hiddenGuess(feedback: GuessFeedback) {
  const hideAttribute = ({ level, hint }: GuessFeedback['attributes']['team']) => ({
    level,
    ...(hint ? { hint } : {}),
  });
  return {
    hidden: true as const,
    correct: feedback.correct,
    attributes: {
      nationality: hideAttribute(feedback.attributes.nationality),
      team: hideAttribute(feedback.attributes.team),
      age: hideAttribute(feedback.attributes.age),
      role: hideAttribute(feedback.attributes.role),
      majorChampionships: hideAttribute(feedback.attributes.majorChampionships),
      majorAppearances: hideAttribute(feedback.attributes.majorAppearances),
      isActive: hideAttribute(feedback.attributes.isActive),
    },
  };
}

export function connectedSpectatorCount(room: StoredRoom): number {
  return room.spectators.reduce((count, spectator) => count + (spectator.connected ? 1 : 0), 0);
}

export function identityDisplayName(identity: StoredIdentity): string {
  if (identity.userId !== null) {
    return /^用户#[0-9A-Z]{5}$/.test(identity.name)
      ? identity.name
      : userNameFromUsername(identity.name);
  }
  if (identity.key.startsWith('g:')) {
    return /^访客#[0-9A-Z]{5}$/.test(identity.name)
      ? identity.name
      : guestNameFromKey(identity.key.slice(2));
  }
  return identity.name;
}

function replayAnswer(target: Player) {
  return {
    id: target.id,
    nickname: target.nickname,
    nationality: target.nationality,
    region: target.region,
    team: target.team,
    age: target.age,
    role: target.role,
    majorChampionships: target.major_championships,
    majorAppearances: target.major_appearances,
    isActive: Boolean(target.is_active),
  };
}

function replayGuesses(target: Player, playerIds: number[], maxGuesses: number) {
  return playerIds.slice(0, maxGuesses).flatMap((playerId) => {
    const guess = getPlayer(playerId);
    return guess ? [visibleGuess(compareGuess(guess, target))] : [];
  });
}

function buildMatchReplay(room: StoredRoom, viewerKey: string) {
  if (room.status !== 'finished' || !room.matchResult) return null;
  const me = room.players.find((player) => player.key === viewerKey);
  const opponent = room.players.find((player) => player.key !== viewerKey);
  if (!me) return null;
  const participantIdByKey = new Map(room.players.map((player, index) => [player.key, `p${index + 1}`]));
  const participants = room.players.map((player) => ({
    id: participantIdByKey.get(player.key)!,
    displayId: identityDisplayName(player),
    score: player.score,
    isMe: player.key === viewerKey,
    isWinner: player.key === room.matchResult?.winnerKey,
    eliminated: player.eliminated,
    eliminationReason: player.eliminationReason,
  }));

  return {
    id: room.recordId,
    mode: room.dbType,
    boType: room.boType,
    gameMode: room.gameMode,
    totalRounds: room.totalRounds,
    maxPlayers: room.maxPlayers,
    relaySolvedRounds: room.relaySolvedRounds,
    finishedAt: new Date(room.updatedAt).toISOString(),
    result: room.gameMode === 'relay'
      ? 'cooperative' as const
      : room.matchResult.winnerKey === me.key
        ? 'won' as const
        : room.matchResult.winnerKey
          ? 'lost' as const
          : 'draw' as const,
    me: { score: me.score },
    ...(opponent ? { opponent: {
      displayId: identityDisplayName(opponent),
      score: opponent.score,
    } } : {}),
    participants,
    winnerParticipantId: room.matchResult.winnerKey
      ? participantIdByKey.get(room.matchResult.winnerKey) ?? null
      : null,
    rounds: room.replayRounds.flatMap((round) => {
      const target = getPlayer(round.targetPlayerId);
      if (!target) return [];
      return [{
        round: round.round,
        reason: round.reason,
        winner: round.winnerKey === me.key
          ? 'me' as const
          : opponent && round.winnerKey === opponent.key
            ? 'opponent' as const
            : null,
        winnerParticipantId: round.winnerKey
          ? participantIdByKey.get(round.winnerKey) ?? null
          : null,
        answer: replayAnswer(target),
        me: { guesses: replayGuesses(target, round.guessesByPlayer[me.key] ?? [], room.maxGuesses) },
        ...(opponent ? { opponent: {
          guesses: replayGuesses(target, round.guessesByPlayer[opponent.key] ?? [], room.maxGuesses),
        } } : {}),
        players: room.players.map((player) => ({
          participantId: participantIdByKey.get(player.key)!,
          guesses: replayGuesses(target, round.guessesByPlayer[player.key] ?? [], room.maxGuesses),
          guessTimes: round.guessTimesByPlayer[player.key] ?? [],
        })),
        sharedGuesses: round.sharedGuesses?.flatMap((guess) => {
          const player = getPlayer(guess.playerId);
          if (!player) return [];
          const actorIdentity = room.players.find((candidate) => candidate.key === guess.actorKey);
          return [{
            actor: guess.actorKey === me.key
              ? 'me' as const
              : opponent && guess.actorKey === opponent.key ? 'opponent' as const : null,
            actorDisplayId: actorIdentity ? identityDisplayName(actorIdentity) : null,
            feedback: visibleGuess(compareGuess(player, target)),
            guessTime: guess.guessTime,
          }];
        }) ?? [],
      }];
    }),
  };
}

function answerView(targetPlayerId: number | null) {
  const target = targetPlayerId ? getPlayer(targetPlayerId) : null;
  return target
    ? {
        nickname: target.nickname,
        team: target.team,
        nationality: target.nationality,
        region: target.region,
        role: target.role,
        majorChampionships: target.major_championships,
        majorAppearances: target.major_appearances,
      }
    : null;
}

export function buildPublicRoom(room: StoredRoom, viewerKey: string) {
  const viewerIsSpectator = room.spectators.some((spectator) => spectator.key === viewerKey);
  const roundIsComplete = room.status === 'round_over' || room.status === 'finished';
  const target = room.targetPlayerId ? getPlayer(room.targetPlayerId) : undefined;
  const matchReplay = buildMatchReplay(room, viewerKey);
  return {
    id: room.id,
    hostKey: room.hostKey,
    status: room.status === 'starting' ? 'waiting' : room.status,
    matchmaking: room.matchmaking,
    readyCheckEndsAt: room.readyCheckEndsAt,
    dbType: room.dbType,
    boType: room.boType,
    gameMode: room.gameMode,
    totalRounds: room.totalRounds,
    maxPlayers: room.maxPlayers,
    currentTurnKey: room.currentTurnKey,
    relaySolvedRounds: room.relaySolvedRounds,
    relayGuesses: room.relayGuesses.map((guess) => ({
      actorKey: guess.actorKey,
      guessedAt: guess.guessedAt,
      feedback: visibleGuess(guess.feedback),
    })),
    rematchAllowed: room.rematchAllowed,
    rematchInvite: room.rematchInviterKey
      ? {
          inviterKey: room.rematchInviterKey,
          acceptedKeys: room.rematchAcceptedKeys,
          requiredKeys: room.rematchRequiredKeys,
        }
      : null,
    allowSpectators: room.allowSpectators,
    verifiedOnly: room.verifiedOnly,
    anonymous: room.anonymous,
    round: room.round,
    winsNeeded: winsNeeded(room.boType),
    maxGuesses: room.maxGuesses,
    guessIntervalMs: room.guessIntervalMs,
    roundDurationMs: room.roundDurationMs,
    roundEndsAt: room.roundEndsAt,
    matchStartsAt: room.status === 'starting' ? room.nextRoundAt : null,
    roundId: room.round,
    stateVersion: room.revision,
    spectatorCount: connectedSpectatorCount(room),
    roundResult: room.matchResult || !room.roundResult
      ? null
      : {
          winnerKey: room.roundResult.winnerKey,
          reason: room.roundResult.reason,
          nextRoundAt: room.roundResult.nextRoundAt,
          answer: answerView(room.targetPlayerId),
        },
    matchResult: room.matchResult
      ? {
          winnerKey: room.matchResult.winnerKey,
          reason: room.matchResult.reason,
          answer: answerView(room.targetPlayerId),
        }
      : null,
    reportSubmitted: room.matchmaking && room.reports.some((report) => report.reporterKey === viewerKey),
    ...(matchReplay ? { matchReplay } : {}),
    players: room.players.map((player) => {
      const guesses = player.guesses.map((feedback) => {
        const guess = getPlayer(feedback.playerId);
        return refreshGuessFeedback(feedback, guess, target);
      });
      return {
        key: player.key,
        name: identityDisplayName(player),
        ready: player.ready,
        connected: player.connected,
        score: player.score,
        skipped: player.skipped,
        guessCount: guesses.length,
        eliminated: player.eliminated,
        eliminationReason: player.eliminationReason,
        guesses: viewerIsSpectator || roundIsComplete || player.key === viewerKey
          ? guesses.map(visibleGuess)
          : guesses.map(hiddenGuess),
      };
    }),
  };
}

export type PublicRoom = ReturnType<typeof buildPublicRoom>;

export type RoomPatchChanges = {
  hostKey?: string;
  players?: {
    added?: PublicRoom['players'];
    updated?: Array<Partial<PublicRoom['players'][number]> & { key: string }>;
    removed?: string[];
  };
  spectatorCount?: number;
  rematchInvite?: PublicRoom['rematchInvite'];
};

const publicRoomCache = new WeakMap<StoredRoom, {
  revision: number;
  views: Map<string, PublicRoom>;
}>();

export function publicRoom(room: StoredRoom, viewerKey: string): PublicRoom {
  const spectator = room.spectators.some((candidate) => candidate.key === viewerKey);
  const cacheKey = spectator ? 'spectator' : viewerKey;
  let cached = publicRoomCache.get(room);
  if (!cached || cached.revision !== room.revision) {
    cached = { revision: room.revision, views: new Map() };
    publicRoomCache.set(room, cached);
  }
  const existing = cached.views.get(cacheKey);
  if (existing) return existing;
  const view = buildPublicRoom(room, viewerKey);
  cached.views.set(cacheKey, view);
  return view;
}

export function emitRoomViews<T>(
  io: Server,
  room: StoredRoom,
  event: string,
  payload: (viewerKey: string) => T
): void {
  for (const player of room.players.filter((candidate) => !candidate.eliminated)) {
    io.to(identityChannel(player.key)).emit(event, payload(player.key));
  }
  if (room.spectators.length) {
    const channels = room.spectators.map((spectator) => identityChannel(spectator.key));
    io.to(channels).emit(event, payload(room.spectators[0].key));
  }
}

export function emitRoomPatch(io: Server, room: StoredRoom, changes: RoomPatchChanges): void {
  const channels = [...room.players.filter((player) => !player.eliminated), ...room.spectators]
    .map((member) => identityChannel(member.key));
  if (!channels.length) return;
  io.to(channels).emit('room:patch', {
    roomId: room.id,
    baseVersion: Math.max(0, room.revision - 1),
    stateVersion: room.revision,
    ...changes,
  });
}
