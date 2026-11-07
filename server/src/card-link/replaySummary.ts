import { compareResults } from '@friberg/card-link-core';
import { z } from 'zod';
import { decodeReplay } from './replay';
import { seatId } from './views';

export const replaySummarySchema = z.object({
  dailyPractice: z.boolean(), rounds: z.number().int().min(1).max(3),
  retired: z.boolean(), rank: z.number().int().min(1).max(8).nullable(),
});

export function replaySummary(replay: Pick<ReturnType<typeof decodeReplay>, 'match' | 'players'>, identity: string) {
  const me = replay.players.find(player => player.id === seatId(identity));
  const rank = me ? 1 + replay.players.filter(player =>
    (Number(player.retired) - Number(me.retired) || compareResults(player.results, me.results)) < 0
  ).length : null;
  return { dailyPractice: replay.match.dailyPractice === true, rounds: replay.match.questions.length,
    retired: me?.retired ?? false, rank: ['friend', 'ranked'].includes(replay.match.scene) ? rank : null };
}
