import { db } from '../db/knex';
import { StoredIdentity } from './roomStore';
import { cached } from './queryCache';

function summary(row: any, includeGuessMetrics: boolean) {
  const games = Number(row?.games ?? 0);
  const wins = Number(row?.wins ?? 0);
  return {
    games,
    wins,
    losses: Math.max(0, games - wins),
    winRate: games ? wins / games : 0,
    ...(includeGuessMetrics
      ? {
          avgGuesses: row?.avgGuesses != null ? Number(row.avgGuesses) : null,
          bestGuesses: row?.bestGuesses != null ? Number(row.bestGuesses) : null,
        }
      : {}),
  };
}

interface ReplayRound {
  round?: unknown;
  winnerKey?: unknown;
  guessesByPlayer?: unknown;
}

function replayRounds(value: unknown): ReplayRound[] {
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    return Array.isArray(parsed) ? parsed.filter((round) => round && typeof round === 'object') : [];
  } catch {
    return [];
  }
}

function guessCount(round: ReplayRound, playerKey: string): number {
  if (!round.guessesByPlayer || typeof round.guessesByPlayer !== 'object') return 0;
  const guesses = (round.guessesByPlayer as Record<string, unknown>)[playerKey];
  return Array.isArray(guesses) ? guesses.length : 0;
}

function isoDate(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

async function loadPlayerPerformance(identity: StoredIdentity) {
  const singleQuery = db('games').whereNot('status', 'playing');
  if (identity.userId !== null) {
    singleQuery.where({ user_id: identity.userId });
  } else if (identity.key.startsWith('g:')) {
    singleQuery.where({ guest_key: identity.key.slice(2) });
  } else {
    singleQuery.whereRaw('1 = 0');
  }

  const [single, multi, recentRows] = await Promise.all([
    singleQuery
      .first()
      .count({ games: 'id' })
      .sum({ wins: db.raw("case when status = 'won' then 1 else 0 end") })
      .avg({ avgGuesses: db.raw("case when status = 'won' then guess_count else null end") })
      .min({ bestGuesses: db.raw("case when status = 'won' then guess_count else null end") }),
    db('match_players')
      .join('match_records as match_summary', 'match_summary.id', 'match_players.match_id')
      .where({ player_key: identity.key })
      .where('match_summary.game_mode', 'classic')
      .first()
      .count({ games: 'match_players.id' })
      .sum({ wins: db.raw('case when is_winner then 1 else 0 end') }),
    db('match_players as me')
      .join('match_records as match', 'match.id', 'me.match_id')
      .where('me.player_key', identity.key)
      .where('match.game_mode', 'classic')
      .select(
        'match.id',
        'match.db_type',
        'match.bo_type',
        'match.winner_key',
        'match.replay',
        'match.created_at',
        'me.score as my_score',
        'me.is_winner as my_is_winner'
      )
      .orderBy('match.created_at', 'desc')
      .orderBy('match.id', 'desc')
      .limit(10),
  ]);

  const matchIds = recentRows.map((row) => Number(row.id)).filter(Number.isInteger);
  const participantRows = matchIds.length
    ? await db('match_players')
        .whereIn('match_id', matchIds)
        .select('match_id', 'player_key', 'player_name', 'score', 'is_winner')
    : [];
  const participantsByMatch = new Map<number, typeof participantRows>();
  for (const participant of participantRows) {
    const matchId = Number(participant.match_id);
    const list = participantsByMatch.get(matchId) ?? [];
    list.push(participant);
    participantsByMatch.set(matchId, list);
  }

  const wonRoundGuesses: number[] = [];
  const parsedRecent = recentRows.map((row) => {
    const rounds = replayRounds(row.replay);
    for (const round of rounds) {
      if (round.winnerKey === identity.key) wonRoundGuesses.push(guessCount(round, identity.key));
    }
    const participants = participantsByMatch.get(Number(row.id)) ?? [];
    const opponent = participants.find((participant) => participant.player_key !== identity.key);
    const hasWinner = participants.some((participant) => Boolean(participant.is_winner));
    const myScore = Number(row.my_score ?? 0);
    const opponentScore = Math.max(0, ...participants
      .filter((participant) => participant.player_key !== identity.key)
      .map((participant) => Number(participant.score ?? 0)));
    return {
      id: Number(row.id),
      result: row.winner_key === identity.key || Boolean(row.my_is_winner)
        ? 'won' as const
        : row.winner_key != null || hasWinner
          ? 'lost' as const
          : 'draw' as const,
      score: { me: myScore, opponent: opponentScore },
      boType: Number(row.bo_type),
      dbType: String(row.db_type),
      opponentDisplayId: participants.length > 2
        ? participants
            .filter((participant) => participant.player_key !== identity.key)
            .map((participant) => String(participant.player_name || participant.player_key || '-'))
            .join(' / ')
        : String(opponent?.player_name || opponent?.player_key || '-'),
      finishedAt: isoDate(row.created_at),
      rounds: rounds.map((round, index) => ({
        round: Number(round.round) || index + 1,
        winner: round.winnerKey === identity.key
          ? 'me' as const
          : round.winnerKey == null
            ? null
            : 'opponent' as const,
        meGuesses: guessCount(round, identity.key),
        opponentGuesses: opponent ? guessCount(round, String(opponent.player_key)) : 0,
      })),
    };
  });

  return {
    single: summary(single, true),
    multi: {
      ...summary(multi, false),
      recentAverageWinningGuesses: wonRoundGuesses.length
        ? wonRoundGuesses.reduce((sum, count) => sum + count, 0) / wonRoundGuesses.length
        : null,
      recentMatches: parsedRecent.slice(0, 3),
    },
  };
}

/** Cached public performance summary for a room member. */
export async function getPlayerPerformance(identity: StoredIdentity) {
  return cached(`room-player-performance:${identity.key}`, 30, () => loadPlayerPerformance(identity));
}
