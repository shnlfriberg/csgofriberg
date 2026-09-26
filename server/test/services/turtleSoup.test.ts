import { randomUUID } from 'crypto';
import { describe, expect, it } from 'vitest';
import type { Player } from '../../src/types';
import { compareGuess, compareQuestion } from '../../src/services/gameService';
import { askSoup, createSoup, guessSoup, soupQuestionSchema, soupView } from '../../src/services/turtleSoup';

const target: Player = {
  id: 1, nickname: 'target', nationality: '瑞典', region: '欧洲', team: 'Current',
  team_history: ['Former'], age: 25, role: 'Rifler', major_championships: 2,
  major_appearances: 10, is_active: true, is_enabled: true, created_at: '',
};

describe('turtle soup rules', () => {
  it.each([
    ['age', 25, 'correct'], ['age', 22, 'close'], ['age', 28, 'close'], ['age', 21, 'wrong'], ['age', 29, 'wrong'],
    ['majorChampionships', 2, 'correct'], ['majorChampionships', 1, 'close'], ['majorChampionships', 4, 'wrong'],
    ['majorAppearances', 10, 'correct'], ['majorAppearances', 11, 'close'], ['majorAppearances', 8, 'wrong'],
    ['team', 'Current', 'correct'], ['team', 'Former', 'close'], ['team', 'Other', 'wrong'],
    ['nationality', '瑞典', 'correct'], ['nationality', '丹麦', 'close'],
    ['role', 'Rifler', 'correct'], ['role', 'Coach', 'wrong'],
    ['isActive', true, 'correct'], ['isActive', false, 'wrong'],
  ] as const)('compares %s=%s with classic thresholds', (field, value, expected) => {
    expect(compareQuestion(target, field, value, '欧洲').level).toBe(expected);
  });

  it('does not treat unknown or different regions as close', () => {
    expect(compareQuestion(target, 'nationality', '美国', '北美洲').level).toBe('wrong');
    expect(compareQuestion({ ...target, region: '' }, 'nationality', '丹麦', '').level).toBe('wrong');
  });

  it('uses the same team and age feedback as classic comparison', () => {
    const guess = { ...target, id: 2, team: 'Former', age: 28 };
    const classic = compareGuess(guess, target);
    expect(compareQuestion(target, 'team', guess.team)).toEqual(classic.attributes.team);
    expect(compareQuestion(target, 'age', guess.age)).toEqual(classic.attributes.age);
  });

  it.each([true, false])('spends a shared budget and settles the 24th guess (correct=%s)', (correct) => {
    const soup = createSoup(target, [target]);
    for (let index = 0; index < 23; index++) {
      if (index % 2) askSoup(soup, { requestId: randomUUID(), version: index, field: 'age', value: 25 }, index * 1000);
      else guessSoup(soup, { ...target, id: 2 }, randomUUID(), index * 1000);
    }
    expect(soup.status).toBe('playing');
    expect(soupView({ id: 'test', mode: 'easy', soup }).remainingQuestions).toBe(1);
    guessSoup(soup, { ...target, id: correct ? target.id : 2 }, randomUUID(), 24000);
    expect(soup.status).toBe(correct ? 'won' : 'lost');
    expect(soup.questionCount + soup.guessCount).toBe(24);
    expect(soupView({ id: 'test', mode: 'easy', soup }).remainingQuestions).toBe(0);
    expect(() => guessSoup(soup, target, randomUUID(), 25000)).toThrow('GAME_FINISHED');
  });

  it('allows 24 consecutive guesses without any questions', () => {
    const soup = createSoup(target, [target]);
    for (let index = 0; index < 24; index++) guessSoup(soup, { ...target, id: 2 }, randomUUID(), index);
    expect(soup).toMatchObject({ questionCount: 0, guessCount: 24, status: 'lost' });
  });

  it('settles a loss when the final attempt is an attribute question', () => {
    const soup = createSoup(target, [target]);
    for (let index = 0; index < 24; index++) {
      askSoup(soup, { requestId: randomUUID(), version: index, field: 'age', value: 25 }, index);
    }
    expect(soup.status).toBe('lost');
    expect(() => guessSoup(soup, target, randomUUID(), 25)).toThrow('GAME_FINISHED');
    expect(() => askSoup(soup, { requestId: randomUUID(), version: 24, field: 'age', value: 25 }, 25)).toThrow('GAME_FINISHED');
  });

  it('allows consecutive guesses and snapshots data independently', () => {
    const original = structuredClone(target);
    const soup = createSoup(original, [original]);
    original.age = 99;
    original.team_history.push('New');
    askSoup(soup, { requestId: randomUUID(), version: 0, field: 'age', value: 25 }, 0);
    askSoup(soup, { requestId: randomUUID(), version: 1, field: 'team', value: 'Former' }, 0);
    expect(soup.events[0]).toMatchObject({ level: 'correct' });
    expect(soup.options.teams).not.toContain('New');
    guessSoup(soup, { ...target, id: 2 }, randomUUID(), 1);
    expect(soupView({ id: 'test', mode: 'easy', soup })).not.toHaveProperty('answer');
    expect(JSON.stringify(soupView({ id: 'test', mode: 'easy', soup }))).not.toContain('team_history');
    guessSoup(soup, target, randomUUID(), 2);
    expect(soup.status).toBe('won');
  });

  it.each([
    ['age', 22, 'higher'], ['age', 29, 'lower'],
    ['majorChampionships', 1, 'higher'], ['majorChampionships', 4, 'lower'],
    ['majorAppearances', 8, 'higher'], ['majorAppearances', 11, 'lower'],
  ] as const)('persists the direction for %s=%s', (field, value, hint) => {
    const soup = createSoup(target, [target]);
    askSoup(soup, { requestId: randomUUID(), version: 0, field, value }, 0);
    expect(soup.events[0]).toMatchObject({ field, value, hint });
  });

  it.each([
    { field: 'age', value: 2.5 }, { field: 'age', value: 0 }, { field: 'age', value: '25' },
    { field: 'majorChampionships', value: -1 }, { field: 'majorAppearances', value: Infinity },
    { field: 'role', value: 'IGL' }, { field: 'isActive', value: 'true' }, { field: 'unknown', value: 1 },
  ])('rejects malformed question $field=$value', (question) => {
    expect(soupQuestionSchema.safeParse({ ...question, version: 0, requestId: randomUUID() }).success).toBe(false);
  });
});
