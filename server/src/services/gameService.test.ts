import { describe, it, expect } from 'vitest';
import { compareGuess, completeGuessFeedback } from './gameService';
import { Player } from '../types';

function makePlayer(overrides: Partial<Player>): Player {
  return {
    id: 1,
    nickname: 'test',
    nationality: '瑞典',
    region: '欧洲',
    team: 'NIP',
    age: 35,
    role: 'Rifler',
    major_championships: 1,
    major_appearances: 12,
    is_active: true,
    created_at: '',
    ...overrides,
  };
}

describe('compareGuess', () => {
  const target = makePlayer({ id: 10, nickname: 'friberg' });

  it('猜中时所有属性 correct', () => {
    const fb = compareGuess(target, target);
    expect(fb.correct).toBe(true);
    expect(Object.values(fb.attributes).every((a) => a.level === 'correct')).toBe(true);
  });

  it('同赛区不同国家或地区给 close', () => {
    const guess = makePlayer({ id: 2, nationality: '丹麦', region: '欧洲' });
    expect(compareGuess(guess, target).attributes.nationality.level).toBe('close');
  });

  it('不同赛区的国家或地区给 wrong', () => {
    const guess = makePlayer({ id: 2, nationality: '巴西', region: '南美' });
    const fb = compareGuess(guess, target);
    expect(fb.attributes.nationality.level).toBe('wrong');
    expect(fb.attributes.region.level).toBe('wrong');
  });

  it('年龄相差 3 岁给 close 并带方向提示', () => {
    const guess = makePlayer({ id: 2, age: target.age - 3 });
    const fb = compareGuess(guess, target);
    expect(fb.attributes.age.level).toBe('close');
    // 猜的人更年轻,目标年龄更大
    expect(fb.attributes.age.hint).toBe('higher');
  });

  it('年龄相差 4 岁给 wrong', () => {
    const guess = makePlayer({ id: 2, age: target.age - 4 });
    expect(compareGuess(guess, target).attributes.age.level).toBe('wrong');
  });

  it('Major 参赛次数相差 1 给 close 并带方向提示', () => {
    const guess = makePlayer({ id: 2, major_appearances: target.major_appearances - 1 });
    const fb = compareGuess(guess, target);
    expect(fb.attributes.majorAppearances.level).toBe('close');
    expect(fb.attributes.majorAppearances.hint).toBe('higher');
  });

  it('Major 参赛次数相差 2 给 wrong 并带方向提示', () => {
    const guess = makePlayer({ id: 2, major_appearances: target.major_appearances - 2 });
    const fb = compareGuess(guess, target);
    expect(fb.attributes.majorAppearances.level).toBe('wrong');
    expect(fb.attributes.majorAppearances.hint).toBe('higher');
  });

  it('Major 冠军数相差 1 给 close 并带方向提示', () => {
    const guess = makePlayer({ id: 2, major_championships: 0 });
    const fb = compareGuess(guess, target);
    expect(fb.attributes.majorChampionships.level).toBe('close');
    expect(fb.attributes.majorChampionships.hint).toBe('higher');
  });

  it('Major 冠军数相差 2 给 wrong', () => {
    const guess = makePlayer({ id: 2, major_championships: target.major_championships + 2 });
    expect(compareGuess(guess, target).attributes.majorChampionships.level).toBe('wrong');
  });

  it('位置不同时给 wrong', () => {
    const guess = makePlayer({ id: 2, role: 'AWPer' });
    expect(compareGuess(guess, target).attributes.role.level).toBe('wrong');
  });

  it('旧反馈缺少选手数据时使用未知冠军数占位', () => {
    const legacy = compareGuess(target, target);
    delete (legacy.attributes as Partial<typeof legacy.attributes>).majorChampionships;
    expect(completeGuessFeedback(legacy).attributes.majorChampionships).toEqual({
      value: '-',
      level: 'wrong',
    });
  });

  it('现役状态不同给 wrong', () => {
    const guess = makePlayer({ id: 2, is_active: false });
    expect(compareGuess(guess, target).attributes.isActive.level).toBe('wrong');
  });
});
