import { z } from 'zod';
import { db } from '../../db/knex';
import { asyncHandler, HttpError } from '../../middleware/common';
import { compareGuess } from '../../services/gameService';
import { getPlayer } from '../../services/playerCache';
import { userGameReplayParamsSchema, userMatchReplayParamsSchema } from '../../routes/adminSchemas';
import { matchPlayerDisplayId, replayAnswer, replayGuessesWithTimes } from './helpers';
import { adminSingleGameReplay } from './gameViews';

export const getUserGameReplay = asyncHandler(async (req, res) => {
    const { userId, gameId } = req.params as unknown as z.infer<typeof userGameReplayParamsSchema>;
    const game = await db('games')
      .where({ id: gameId, user_id: userId })
      .whereNot('status', 'playing')
      .first();
    if (!game) throw new HttpError(404, 'GAME_NOT_FOUND');
    res.json(adminSingleGameReplay(game));
  });

export const getUserMatchReplay = asyncHandler(async (req, res) => {
    const { userId, matchId } = req.params as unknown as z.infer<typeof userMatchReplayParamsSchema>;
    const match = await db('match_records as m')
      .join('match_players as me', 'me.match_id', 'm.id')
      .where('m.id', matchId)
      .where('me.user_id', userId)
      .first(
        'm.id',
        'm.db_type as mode',
        'm.bo_type as boType',
        'm.game_mode as gameMode',
        'm.total_rounds as totalRounds',
        'm.relay_solved_rounds as relaySolvedRounds',
        'm.replay',
        'm.created_at as finishedAt',
        'me.id as mePlayerId',
        'me.player_key as meKey',
        'me.score as meScore',
        'me.is_winner as meWinner'
      );
    if (!match) throw new HttpError(404, 'GAME_NOT_FOUND');
    const opponent = await db('match_players as opponent')
      .leftJoin('users as opponent_user', 'opponent_user.id', 'opponent.user_id')
      .where('opponent.match_id', matchId)
      .whereNot('opponent.id', match.mePlayerId)
      .first(
        'opponent.player_key as key',
        'opponent.player_name as name',
        'opponent.score',
        'opponent.is_winner as isWinner',
        'opponent_user.username'
      );
    if (!opponent) throw new HttpError(404, 'GAME_NOT_FOUND');

    let storedRounds: unknown[] = [];
    try {
      const parsed = JSON.parse(String(match.replay));
      if (Array.isArray(parsed)) storedRounds = parsed.slice(0, 30);
    } catch {
      throw new HttpError(500, 'INTERNAL_ERROR');
    }
    const rounds = storedRounds.flatMap((stored) => {
      if (!stored || typeof stored !== 'object') return [];
      const round = stored as Record<string, unknown>;
      const target = getPlayer(Number(round.targetPlayerId));
      if (!target) return [];
      const guessesByPlayer = round.guessesByPlayer;
      if (!guessesByPlayer || typeof guessesByPlayer !== 'object') return [];
      const guesses = guessesByPlayer as Record<string, unknown>;
      const storedTimes = round.guessTimesByPlayer && typeof round.guessTimesByPlayer === 'object'
        ? round.guessTimesByPlayer as Record<string, unknown>
        : {};
      const sharedGuesses = Array.isArray(round.sharedGuesses)
        ? round.sharedGuesses.slice(0, 15).flatMap((item) => {
          if (!item || typeof item !== 'object') return [];
          const storedGuess = item as Record<string, unknown>;
          const guess = getPlayer(Number(storedGuess.playerId));
          if (!guess) return [];
          const actorKey = typeof storedGuess.actorKey === 'string' ? storedGuess.actorKey : '';
          return [{
            actor: actorKey === match.meKey
              ? 'me' as const
              : actorKey === opponent.key ? 'opponent' as const : null,
            feedback: compareGuess(guess, target),
            guessTime: Number.isFinite(Number(storedGuess.guessTime))
              ? Number(storedGuess.guessTime)
              : null,
          }];
        })
        : [];
      const winnerKey = typeof round.winnerKey === 'string' ? round.winnerKey : null;
      return [{
        round: Number(round.round),
        reason: typeof round.reason === 'string' ? round.reason : '',
        winner: winnerKey === match.meKey ? 'me' : winnerKey === opponent.key ? 'opponent' : null,
        answer: replayAnswer(target),
        me: replayGuessesWithTimes(target, guesses[match.meKey], storedTimes[match.meKey]),
        opponent: replayGuessesWithTimes(target, guesses[opponent.key], storedTimes[opponent.key]),
        sharedGuesses,
      }];
    });
    res.json({
      id: Number(match.id),
      mode: match.mode,
      boType: Number(match.boType),
      gameMode: match.gameMode === 'relay' ? 'relay' : 'classic',
      totalRounds: Number(match.totalRounds),
      relaySolvedRounds: Number(match.relaySolvedRounds),
      finishedAt: match.finishedAt,
      result: match.gameMode === 'relay'
        ? 'cooperative'
        : Boolean(match.meWinner) ? 'won' : Boolean(opponent.isWinner) ? 'lost' : 'draw',
      me: { score: Number(match.meScore) },
      opponent: {
        displayId: matchPlayerDisplayId(opponent),
        score: Number(opponent.score),
      },
      rounds,
    });
  });
