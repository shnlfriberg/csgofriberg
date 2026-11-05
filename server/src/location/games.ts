import { randomUUID } from 'crypto';
import { publicReplay } from './publicIdentity';
import { db } from '../db/knex';
import { HttpError } from '../middleware/common';
import { withKeyLock } from './lock';
import { startGameSchema } from './validation';
import { encodeReplay, decodeReplay, decodeProgress } from './replayStorage';
import { assertGuess, dayWindow, sample, sampleDaily, score } from './rules';
import {
  catalogSnapshot,
  activeGameKey,
  deleteState,
  loadGame,
  readState,
  saveGame,
} from './store';
import type {
  DailyAssignment,
  AnswerInput,
  Difficulty,
  GameState,
  GameView,
  Identity,
  QuestionSnapshot,
  RoundResult,
  ReplayRecord,
} from './types';

export type { DailyAssignment } from './types';
export async function ensureDaily(now = Date.now()): Promise<DailyAssignment> {
  const { date } = dayWindow(now);
  const fixed = await db('location_daily').where({ date }).first();
  if (fixed) return JSON.parse(fixed.payload) as DailyAssignment;
  return withKeyLock(`location:daily:${date}`, async () => {
    const existing = await db('location_daily').where({ date }).first();
    if (existing) return JSON.parse(existing.payload) as DailyAssignment;
    const catalog = await catalogSnapshot();
    const decks = sampleDaily(catalog.pool);
    const assignment: DailyAssignment = {
      date,
      decks,
      maps: catalog.maps,
      scoringVersion: 1,
    };
    await db('location_daily')
      .insert({ date, payload: JSON.stringify(assignment) })
      .onConflict('date')
      .ignore();
    return JSON.parse(
      (await db('location_daily').where({ date }).first()).payload
    );
  });
}
export async function randomSelection(
  difficulty: Difficulty,
  bannedMapIds: string[] = []
): Promise<{ questions: QuestionSnapshot[]; maps: GameState['maps'] }> {
  let daily: DailyAssignment | null = null;
  try {
    daily = await ensureDaily();
  } catch (error) {
    if (
      !(
        error instanceof HttpError &&
        error.code === 'LOCATION_POOL_INSUFFICIENT'
      )
    )
      throw error;
  }
  const excluded = new Set(
    daily
      ? Object.values(daily.decks)
          .flat()
          .flatMap((item) => [
            item.question.id,
            `point:${item.map.id}:${item.question.capturePointId}`,
          ])
      : []
  );
  const catalog = await catalogSnapshot();
  if (bannedMapIds.some(id => !catalog.maps.some(map => map.id === id)))
    throw new HttpError(400, 'LOCATION_BAN_MAP_INVALID');
  const banned = new Set(bannedMapIds);
  let questions: QuestionSnapshot[];
  try {
    questions = sample(catalog.pool.filter(item => !banned.has(item.map.id)), difficulty, excluded);
  } catch (error) {
    if (banned.size && error instanceof HttpError && error.code === 'LOCATION_POOL_INSUFFICIENT')
      throw new HttpError(409, 'LOCATION_BAN_POOL_INSUFFICIENT');
    throw error;
  }
  return {
    questions,
    maps: catalog.maps,
  };
}
export async function randomDeck(
  difficulty: Difficulty
): Promise<QuestionSnapshot[]> {
  return (await randomSelection(difficulty)).questions;
}
export function gameResults(game: GameState): RoundResult[] {
  return game.guesses.map((guess, index) =>
    score(game.questions[index], guess, game.maps, index + 1)
  );
}
export function gameView(game: GameState): GameView {
  const reveal = game.mode === 'random' || game.status === 'finished';
  const results = reveal ? gameResults(game) : [];
  return {
    id: game.id,
    mode: game.mode,
    ...(game.mode === 'random' ? { bannedMapIds: game.bannedMapIds ?? [] } : {}),
    difficulty: game.difficulty,
    date: game.date,
    status: game.status,
    version: game.version,
    scoringVersion: 1,
    round: Math.min(5, game.guesses.length + 1),
    totalRounds: 5,
    answered: game.guesses.length,
    maps: game.maps,
    question:
      game.status === 'playing'
        ? {
            imageUrl: game.questions[game.guesses.length].question.imageUrl,
            round: game.guesses.length + 1,
          }
        : null,
    guesses: game.guesses,
    results,
    totalScore: reveal
      ? results.reduce((sum, round) => sum + round.score, 0)
      : null,
    expiresAt: game.expiresAt,
  };
}
export async function requiredGame(
  id: string,
  owner: Identity
): Promise<GameState> {
  const game = await loadGame(id, owner);
  if (!game || game.status === 'abandoned')
    throw new HttpError(404, 'LOCATION_GAME_NOT_FOUND');
  if (game.status !== 'finished' && game.expiresAt <= Date.now())
    throw new HttpError(410, 'LOCATION_GAME_EXPIRED');
  return game;
}
// SQL is authoritative once a final result commits, even if its Redis write or
// HTTP response was lost. Read the stored score; never rescore an old result.
async function completedGame(id: string, owner: Identity, input?: AnswerInput): Promise<GameView | null> {
  const row = await db('location_results').where({ game_id: id, identity_key: owner.key }).first('payload');
  if (!row) return null;
  const record = await decodeReplay(row.payload) as ReplayRecord & { answerRequests?: Record<string, string> };
  if (!record.game) return null;
  if (input && record.answerRequests?.[input.requestId] &&
      record.answerRequests[input.requestId] !== JSON.stringify(input))
    throw new HttpError(409, 'LOCATION_REQUEST_CONFLICT');
  return record.game;
}
export async function readGame(id: string, owner: Identity): Promise<GameView> {
  return await completedGame(id, owner) ?? gameView(await requiredGame(id, owner));
}
export async function startGame(
  owner: Identity,
  mode: 'random' | 'daily',
  difficulty: Difficulty,
  bannedMapIds: string[] = []
): Promise<GameView> {
  const validated = startGameSchema.parse({ mode, difficulty, bannedMapIds });
  bannedMapIds = [...validated.bannedMapIds].sort();
  const activeKey = activeGameKey({ owner, mode, difficulty, bannedMapIds });
  return withKeyLock(
    `location:start:${activeKey.slice('active:'.length)}`,
    async () => {
      const window = dayWindow();
      if (mode === 'daily') {
        const official = await db('location_daily_attempts')
          .where({ identity_key: owner.key, date: window.date, difficulty })
          .first();
        if (official) return (await replay(official.game_id, owner)).game!;
        const progress = await db('location_progress')
          .where({ identity_key: owner.key, date: window.date, difficulty })
          .first();
        if (progress) {
          const game = await decodeProgress(progress.payload);
          if (game.status !== 'abandoned') return gameView(game);
        }
      } else {
        const id = await readState<string>(
          activeKey
        );
        const previous = id ? await loadGame(id, owner) : null;
        if (
          previous &&
          previous.status === 'playing' &&
          previous.expiresAt > Date.now() &&
          !(await completedGame(previous.id, owner))
        )
          return gameView(previous);
      }
      const assignment = mode === 'daily' ? await ensureDaily() : null;
      const selection = assignment
        ? { questions: assignment.decks[difficulty], maps: assignment.maps }
        : await randomSelection(difficulty, bannedMapIds);
      const game: GameState = {
        id: randomUUID(),
        owner,
        mode,
        ...(mode === 'random' ? { bannedMapIds } : {}),
        difficulty,
        date: mode === 'daily' ? window.date : null,
        status: 'playing',
        questions: selection.questions,
        maps: selection.maps,
        guesses: [],
        requests: {},
        version: 0,
        scoringVersion: 1,
        createdAt: Date.now(),
        updatedAt: Date.now(),
        expiresAt:
          mode === 'daily' ? window.nextRefreshAt : Date.now() + 1800_000,
      };
      await saveGame(game);
      return gameView(game);
    }
  );
}
export async function recordResult(
  gameId: string,
  owner: Identity,
  mode: 'random' | 'daily' | 'multiplayer',
  difficulty: Difficulty,
  date: string | null,
  results: RoundResult[],
  game?: GameView,
  extra: Record<string, unknown> = {},
  connection = db
): Promise<void> {
  const totalScore = results.reduce((sum, round) => sum + round.score, 0);
  await connection('location_results')
    .insert({
      game_id: gameId,
      identity_key: owner.key,
      user_id: owner.userId,
      mode,
      difficulty,
      date,
      score: totalScore,
      finished_at: Date.now(),
      payload: await encodeReplay({
        gameId,
        owner,
        mode,
        difficulty,
        difficultyMix: Object.fromEntries(
          ['easy', 'medium', 'hard'].map((tier) => [
            tier,
            results.filter((round) => round.tier === tier).length,
          ])
        ),
        date,
        totalScore,
        results,
        scoringVersion: 1,
        game,
        ...extra,
      } as ReplayRecord, connection),
    })
    .onConflict(['game_id', 'identity_key'])
    .ignore();
}
export async function answerGame(
  id: string,
  owner: Identity,
  input: AnswerInput
): Promise<GameView> {
  return withKeyLock(`location:game:${id}`, async () => {
    const completed = await completedGame(id, owner, input);
    if (completed) return completed;
    const game = await requiredGame(id, owner);
    const fingerprint = JSON.stringify(input);
    if (game.requests[input.requestId]) {
      if (game.requests[input.requestId] !== fingerprint)
        throw new HttpError(409, 'LOCATION_REQUEST_CONFLICT');
      return gameView(game);
    }
    if (game.version !== input.version)
      throw new HttpError(409, 'LOCATION_STALE_STATE');
    if (game.status !== 'playing' || input.round !== game.guesses.length + 1)
      throw new HttpError(409, 'LOCATION_ROUND_LOCKED');
    if (game.mode === 'random' && game.bannedMapIds?.includes(input.mapId))
      throw new HttpError(400, 'LOCATION_MAP_BANNED');
    assertGuess(input, game.maps);
    game.guesses.push({
      mapId: input.mapId,
      floorId: input.floorId,
      u: input.u,
      v: input.v,
    });
    game.requests[input.requestId] = fingerprint;
    game.version++;
    game.updatedAt = Date.now();
    if (game.mode === 'random') game.expiresAt = Date.now() + 1800_000;
    if (game.guesses.length === 5)
      game.status = game.mode === 'daily' ? 'ready' : 'finished';
    if (game.status === 'finished')
      await recordResult(
        game.id,
        game.owner,
        game.mode,
        game.difficulty,
        game.date,
        gameResults(game),
        gameView(game),
        { answerRequests: game.requests }
      );
    await saveGame(game);
    return gameView(game);
  });
}
export async function abandonGame(id: string, owner: Identity): Promise<void> {
  await withKeyLock(`location:game:${id}`, async () => {
    if (await completedGame(id, owner)) throw new HttpError(409, 'LOCATION_ALREADY_SUBMITTED');
    const game = await requiredGame(id, owner);
    if (game.status === 'finished')
      throw new HttpError(409, 'LOCATION_ALREADY_SUBMITTED');
    game.status = 'abandoned';
    game.guesses = [];
    await saveGame(game);
    await deleteState(activeGameKey(game));
  });
}
export async function submitDaily(
  id: string,
  owner: Identity
): Promise<GameView> {
  return withKeyLock(`location:daily-submit:${owner.key}`, async () =>
    withKeyLock(`location:game:${id}`, async () => {
      const completed = await completedGame(id, owner);
      if (completed) {
        if (completed.mode !== 'daily') throw new HttpError(400, 'LOCATION_NOT_DAILY');
        return completed;
      }
      const game = await requiredGame(id, owner);
      if (game.mode !== 'daily') throw new HttpError(400, 'LOCATION_NOT_DAILY');
      if (game.status === 'finished') return gameView(game);
      if (game.status !== 'ready' || game.guesses.length !== 5)
        throw new HttpError(409, 'LOCATION_INCOMPLETE');
      game.status = 'finished';
      game.version++;
      const view = gameView(game);
      await db.transaction(async (trx) => {
        const existing = await trx('location_daily_attempts')
          .where({
            identity_key: owner.key,
            date: game.date,
            difficulty: game.difficulty,
          })
          .first();
        if (existing && existing.game_id !== id)
          throw new HttpError(409, 'LOCATION_ALREADY_SUBMITTED');
        await trx('location_daily_attempts')
          .insert({
            identity_key: owner.key,
            date: game.date,
            difficulty: game.difficulty,
            game_id: id,
          })
          .onConflict(['identity_key', 'date', 'difficulty'])
          .ignore();
        await recordResult(
          id,
          owner,
          'daily',
          game.difficulty,
          game.date,
          gameResults(game),
          view,
          { answerRequests: game.requests },
          trx
        );
        await trx('location_progress')
          .where({
            identity_key: owner.key,
            date: game.date,
            difficulty: game.difficulty,
          })
          .update({ payload: JSON.stringify(game) });
      });
      await saveGame(game);
      return view;
    })
  );
}
export async function replay(
  id: string,
  owner: Identity
): Promise<ReplayRecord> {
  const row = await db('location_results')
    .where({ game_id: id, identity_key: owner.key })
    .first();
  if (!row) throw new HttpError(404, 'LOCATION_GAME_NOT_FOUND');
  return publicReplay(await decodeReplay(row.payload));
}
export async function claimLocation(
  guestKey: string,
  userId: number,
  name: string
): Promise<number> {
  const from = `g:${guestKey}`;
  const to = `u:${userId}`;
  return withKeyLock(`location:daily-submit:${to}`, () =>
    db.transaction(async (trx) => {
      const records = await trx('location_results')
        .where({ identity_key: from })
        .select();
      let claimed = 0;
      for (const row of records) {
        if (row.mode === 'daily') {
          const existing = await trx('location_daily_attempts')
            .where({
              identity_key: to,
              date: row.date,
              difficulty: row.difficulty,
            })
            .first();
          if (existing) continue;
          await trx('location_daily_attempts')
            .where({
              identity_key: from,
              date: row.date,
              difficulty: row.difficulty,
            })
            .update({ identity_key: to });
        }
        const payload = JSON.parse(row.payload);
        payload.owner = { key: to, userId, name };
        if (payload.game) payload.game.owner = undefined;
        await trx('location_results')
          .where({ game_id: row.game_id, identity_key: from })
          .update({
            identity_key: to,
            user_id: userId,
            payload: JSON.stringify(payload),
          });
        claimed++;
      }
      return claimed;
    })
  );
}
