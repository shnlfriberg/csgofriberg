import { Player, GuessFeedback, AttributeFeedback } from '../types';

const AGE_CLOSE_RANGE = 3;
const MAJOR_CHAMPIONSHIPS_CLOSE_RANGE = 1;
const MAJOR_APPEARANCES_CLOSE_RANGE = 1;

function textAttr(guess: string, target: string): AttributeFeedback {
  return { value: guess, level: guess === target ? 'correct' : 'wrong' };
}

function teamAttr(guess: Player, target: Player): AttributeFeedback {
  if (guess.team === target.team) {
    return { value: guess.team, level: 'correct' };
  }
  if (guess.team && target.team_history.includes(guess.team)) {
    return { value: guess.team, level: 'close' };
  }
  return { value: guess.team, level: 'wrong' };
}

/** 国家或地区:相同 correct;不同但同赛区 close */
function nationalityAttr(guess: Player, target: Player): AttributeFeedback {
  if (guess.nationality === target.nationality)
    return { value: guess.nationality, level: 'correct' };
  if (guess.region && guess.region === target.region)
    return { value: guess.nationality, level: 'close' };
  return { value: guess.nationality, level: 'wrong' };
}

function numberAttr(
  guessVal: number,
  targetVal: number,
  closeRange: number
): AttributeFeedback {
  if (guessVal === targetVal) return { value: guessVal, level: 'correct' };
  const level = Math.abs(guessVal - targetVal) <= closeRange ? 'close' : 'wrong';
  return {
    value: guessVal,
    level,
    hint: targetVal > guessVal ? 'higher' : 'lower',
  };
}

/** 逐属性对比猜测选手与目标选手,产出反馈 */
export function compareGuess(guess: Player, target: Player): GuessFeedback {
  const correct = guess.id === target.id;
  return {
    playerId: guess.id,
    nickname: guess.nickname,
    correct,
    attributes: {
      nationality: nationalityAttr(guess, target),
      region: textAttr(guess.region, target.region),
      team: teamAttr(guess, target),
      age: numberAttr(guess.age, target.age, AGE_CLOSE_RANGE),
      role: textAttr(guess.role, target.role),
      majorChampionships: numberAttr(
        guess.major_championships,
        target.major_championships,
        MAJOR_CHAMPIONSHIPS_CLOSE_RANGE
      ),
      majorAppearances: numberAttr(
        guess.major_appearances,
        target.major_appearances,
        MAJOR_APPEARANCES_CLOSE_RANGE
      ),
      isActive: {
        value: Boolean(guess.is_active),
        level: Boolean(guess.is_active) === Boolean(target.is_active) ? 'correct' : 'wrong',
      },
    },
  };
}

/** Upgrade Redis game snapshots created before a feedback attribute was added. */
export function completeGuessFeedback(
  feedback: GuessFeedback,
  guess?: Player,
  target?: Player
): GuessFeedback {
  const team = guess && target ? teamAttr(guess, target) : feedback.attributes.team;
  if (feedback.attributes.majorChampionships && team === feedback.attributes.team) return feedback;
  return {
    ...feedback,
    attributes: {
      ...feedback.attributes,
      team,
      majorChampionships: guess && target
        ? numberAttr(
            guess.major_championships,
            target.major_championships,
            MAJOR_CHAMPIONSHIPS_CLOSE_RANGE
          )
        : { value: '-', level: 'wrong' },
    },
  };
}

export const MAX_GUESSES = 8;
