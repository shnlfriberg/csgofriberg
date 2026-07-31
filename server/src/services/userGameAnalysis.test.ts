import { describe, expect, it } from 'vitest';
import type { Player } from '../types';
import { analyzeGameChoices } from './userGameAnalysis';

function player(id: number, age: number, team: string): Player {
  return {
    id,
    nickname: `p${id}`,
    nationality: id % 2 ? 'A' : 'B',
    region: id % 2 ? 'R1' : 'R2',
    team,
    age,
    role: id % 2 ? 'Rifler' : 'AWPer',
    major_championships: id % 3,
    major_appearances: id,
    is_active: true,
    is_enabled: true,
    created_at: '',
  };
}

describe('user game choice analysis', () => {
  it('returns bounded entropy trajectories without treating the final correct guess as evidence', async () => {
    const players = [player(1, 20, 'A'), player(2, 25, 'B'), player(3, 30, 'C'), player(4, 35, 'D')];
    const result = await analyzeGameChoices([{
      source: 'single', recordId: 1, mode: 'easy', finishedAt: '', round: 1,
      targetPlayerId: 4, guessPlayerIds: [1, 4],
    }], new Map(players.map((item) => [item.id, item])), new Map([['easy', players]]), players);

    expect(result.summary.sampleSize).toBe(1);
    expect(result.trajectories[0].steps).toHaveLength(1);
    expect(result.trajectories[0].steps[0]).toMatchObject({
      guessPlayerId: 1,
      candidateCountBefore: 4,
      entropyPercentile: expect.any(Number),
    });
  });

  it('keeps repeated candidate-state rankings stable when reused across rounds', async () => {
    const players = [player(1, 20, 'A'), player(2, 25, 'B'), player(3, 30, 'C'), player(4, 35, 'D')];
    const rounds = [1, 2].map((recordId) => ({
      source: 'multi' as const,
      recordId,
      mode: 'easy',
      finishedAt: '',
      round: recordId,
      targetPlayerId: 4,
      guessPlayerIds: [1, 4],
    }));
    const result = await analyzeGameChoices(
      rounds,
      new Map(players.map((item) => [item.id, item])),
      new Map([['easy', players]]),
      players
    );

    expect(result.summary.sampleSize).toBe(2);
    expect(result.trajectories[0].steps[0]).toEqual(result.trajectories[1].steps[0]);
  });
});
