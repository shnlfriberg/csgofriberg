import { guestNameFromKey, userNameFromUsername } from '../../middleware/auth';
import { compareGuess, MAX_GUESSES } from '../../services/gameService';
import { getPlayer } from '../../services/playerCache';
import type { GuessFeedback, Player } from '../../types';

export function matchPlayerDisplayId(row: { key?: unknown; name?: unknown; username?: unknown }): string {
  const key = typeof row.key === 'string' ? row.key : '';
  const name = typeof row.name === 'string' ? row.name : '';
  if (/^(访客|用户)#[0-9A-Z]{5}$/.test(name)) return name;
  if (key.startsWith('g:')) return guestNameFromKey(key.slice(2));
  if (key.startsWith('u:')) {
    const username = typeof row.username === 'string' && row.username ? row.username : name;
    return username ? userNameFromUsername(username) : '用户#未知';
  }
  return name || '未知对手';
}

export function replayAnswer(target: Player) {
  return {
    id: target.id,
    nickname: target.nickname,
    team: target.team,
    nationality: target.nationality,
    region: target.region,
    age: target.age,
    role: target.role,
    majorChampionships: target.major_championships,
    majorAppearances: target.major_appearances,
    isActive: Boolean(target.is_active),
  };
}

export function replayGuessesWithTimes(target: Player, guessIds: unknown, guessTimes: unknown) {
  const ids = Array.isArray(guessIds) ? guessIds.slice(0, MAX_GUESSES) : [];
  const times = Array.isArray(guessTimes) ? guessTimes : [];
  const guesses: GuessFeedback[] = [];
  const normalizedTimes: Array<number | null> = [];
  let previousGuessAt = 0;
  let previousTimeKnown = true;
  for (const [index, value] of ids.entries()) {
    const id = Number(value);
    if (!Number.isInteger(id) || id <= 0) continue;
    const guess = getPlayer(id);
    if (!guess) continue;
    guesses.push(compareGuess(guess, target));
    const time = times[index];
    if (typeof time !== 'number' || !Number.isFinite(time) || time < 0) {
      normalizedTimes.push(null);
      previousTimeKnown = false;
      continue;
    }
    const currentGuessAt = Math.floor(time);
    normalizedTimes.push(previousTimeKnown ? Math.max(0, currentGuessAt - previousGuessAt) : null);
    previousGuessAt = currentGuessAt;
    previousTimeKnown = true;
  }
  return { guesses, guessTimes: normalizedTimes };
}
