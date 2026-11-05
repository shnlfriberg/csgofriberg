import { HttpError } from '../middleware/common';
import { score } from './rules';
import { publicPlayerKey } from './publicIdentity';
import type { RoomState, RoomView } from './types';

export function roomView(
  room: RoomState,
  identity: string,
  now = Date.now(),
  common?: Pick<RoomView, 'results' | 'players'>
): RoomView {
  const me = room.players.find((p) => p.identity.key === identity);
  if (!me) throw new HttpError(403, 'FORBIDDEN');
  const key = (identityKey: string) => publicPlayerKey(room.gameId, identityKey);
  const results = common?.results ?? room.players.map((p) => ({
    key: key(p.identity.key),
    name: p.identity.name,
    rounds: p.guesses.map((guess, index) =>
      score(room.questions[index], guess, room.maps, index + 1)
    ),
  }));
  const scores = results.map((result) =>
    result.rounds.reduce((sum, round) => sum + round.score, 0)
  );
  return {
    id: room.id,
    gameId: room.gameId,
    me: key(identity),
    viewerUserId: me.identity.userId,
    host: key(room.host),
    status: room.status,
    revision: room.revision,
    difficulty: room.difficulty,
    duration: room.duration,
    round: room.round,
    maps: room.maps,
    question: ['preparing', 'playing'].includes(room.status)
      ? {
          round: room.round,
          imageUrl: room.questions[room.round - 1].question.imageUrl,
        }
      : null,
    serverNow: now,
    startsAt: room.startsAt,
    endsAt: room.endsAt,
    nextAt: room.nextAt,
    myGuess: me.currentGuess,
    results,
    players: common?.players ?? room.players.map((p, index) => ({
      key: key(p.identity.key),
      name: p.identity.name,
      ready: p.ready,
      connected: p.connected,
      retired: p.retired,
      submitted: Boolean(p.currentGuess),
      score: scores[index],
      rank:
        room.status === 'finished' && !p.retired
          ? 1 +
            room.players.filter(
              (other, i) => !other.retired && scores[i] > scores[index]
            ).length
          : null,
    })),
  };
}
