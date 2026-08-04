import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { config } from '../config';
import { db } from '../db/knex';
import { initDb } from '../db/init';
import { HttpError } from '../middleware/common';
import { initRedis } from '../redis';
import { initPlayerCache } from './playerCache';
import { externalAnalysisResponseSchema, requestExternalCheatAnalysis } from './externalCheatAnalysis';

const originalConfig = { ...config.cheatAnalysis };
let userId = 0;
let gameId = 0;
let matchId = 0;
let targetPlayerId = 0;
let guessPlayerId = 0;
const opponentKey = `g:external-analysis-opponent-${Date.now()}`;

beforeAll(async () => {
  await initDb();
  await initRedis();
  await initPlayerCache();
  const stamp = Date.now();
  const [user] = await db('users').insert({
    username: `external-analysis-${stamp}`,
    display_id: `A${String(stamp).slice(-4)}`,
    password_hash: 'test',
    role: 'user',
    token_version: 0,
    email: `private-${stamp}@example.com`,
  }).returning('id');
  userId = Number(typeof user === 'object' ? user.id : user);
  const [target, guess] = await db('players').select('id').orderBy('id').limit(2);
  targetPlayerId = Number(target.id);
  guessPlayerId = Number(guess.id);
  const [game] = await db('games').insert({
    user_id: userId,
    target_player_id: targetPlayerId,
    mode: 'normal',
    guesses: JSON.stringify([guessPlayerId, targetPlayerId]),
    guess_times: JSON.stringify([900, 1750]),
    first_guess_player_id: guessPlayerId,
    status: 'won',
    guess_count: 2,
    finished_at: db.fn.now(),
  }).returning('id');
  gameId = Number(typeof game === 'object' ? game.id : game);

  const subjectKey = `u:${userId}`;
  const [match] = await db('match_records').insert({
    room_id: `external-analysis-${stamp}`,
    db_type: 'normal',
    bo_type: 3,
    winner_id: userId,
    winner_key: subjectKey,
    finish_reason: 'score',
    replay: JSON.stringify([{
      round: 1,
      targetPlayerId,
      winnerKey: subjectKey,
      reason: 'guessed',
      guessesByPlayer: {
        [subjectKey]: [guessPlayerId, targetPlayerId],
        [opponentKey]: [targetPlayerId],
      },
      guessTimesByPlayer: {
        [subjectKey]: [900, 1750],
        [opponentKey]: [1250],
      },
    }]),
  }).returning('id');
  matchId = Number(typeof match === 'object' ? match.id : match);
  await db('match_players').insert([
    {
      match_id: matchId,
      user_id: userId,
      player_key: subjectKey,
      player_name: `external-analysis-${stamp}`,
      score: 2,
      is_winner: true,
      winning_guess_sum: 2,
      winning_rounds: 1,
    },
    {
      match_id: matchId,
      player_key: opponentKey,
      player_name: 'private opponent name',
      score: 1,
      is_winner: false,
      winning_guess_sum: 0,
      winning_rounds: 0,
    },
  ]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  Object.assign(config.cheatAnalysis, originalConfig);
});

afterAll(async () => {
  await db('games').where({ id: gameId }).del();
  await db('match_records').where({ id: matchId }).del();
  await db('users').where({ id: userId }).del();
});

describe('external cheat analysis', () => {
  it('requires an integer decision score between 0 and 100', () => {
    const response = {
      schemaVersion: 1,
      requestId: '11111111-1111-4111-8111-111111111111',
      analysisId: 'score-validation',
      modelVersion: '2026.08.1',
      generatedAt: '2026-08-02T12:00:00.000Z',
      decision: { level: 'medium', score: 50, label: 'Review', summary: 'Review required.' },
      sections: [],
    };
    expect(externalAnalysisResponseSchema.safeParse(response).success).toBe(true);
    expect(externalAnalysisResponseSchema.safeParse({
      ...response,
      decision: { ...response.decision, score: 101 },
    }).success).toBe(false);
    expect(externalAnalysisResponseSchema.safeParse({
      ...response,
      decision: { ...response.decision, score: 49.5 },
    }).success).toBe(false);
  });

  it('sends an anonymous bearer-authenticated snapshot and accepts a validated response', async () => {
    const token = 'analysis-test-token';
    Object.assign(config.cheatAnalysis, {
      apiUrl: 'https://analysis.example.test/v1/analyze',
      apiToken: token,
      timeoutMs: 5_000,
    });
    let capturedBody = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? '');
      const request = JSON.parse(capturedBody);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe(`Bearer ${token}`);
      expect(headers.has('x-analysis-timestamp')).toBe(false);
      expect(headers.has('x-analysis-signature')).toBe(false);
      const responseBody = JSON.stringify({
        schemaVersion: 1,
        requestId: request.requestId,
        analysisId: 'analysis-result-1',
        modelVersion: '2026.08.1',
        generatedAt: '2026-08-02T12:00:00.000Z',
        decision: { level: 'high', score: 92, label: 'High risk', summary: 'Automated behavior detected.' },
        sections: [{
          title: 'Signals',
          items: [{ type: 'metric', label: 'Events', value: 12, displayValue: '12', severity: 'danger' }],
        }],
      });
      return new Response(responseBody, { status: 200 });
    }));

    const result = await requestExternalCheatAnalysis(
      { type: 'user', userId, identityKey: `u:${userId}` },
      'en-US',
      'user-detail'
    );

    const request = JSON.parse(capturedBody);
    expect(request.subject).toEqual({ type: 'user', opaqueId: expect.any(String) });
    expect(request.singleGames).toEqual(expect.arrayContaining([
      expect.objectContaining({
        recordId: gameId,
        targetPlayerId,
        mode: 'normal',
        status: 'won',
        guessCount: 2,
        firstGuessPlayerId: guessPlayerId,
        guessPlayerIds: [guessPlayerId, targetPlayerId],
        guessTimesMs: [900, 1750],
        startedAt: expect.any(String),
        finishedAt: expect.any(String),
      }),
    ]));

    const databasePlayerCount = Number((await db('players').count({ count: 'id' }).first())?.count ?? 0);
    const targetPlayer = await db('players').where({ id: targetPlayerId }).first();
    const targetDifficulties = await db('player_difficulties')
      .where({ player_id: targetPlayerId })
      .orderBy('difficulty_key')
      .pluck('difficulty_key');
    expect(request.playerPool.revision).toEqual(expect.any(String));
    expect(request.playerPool.players).toHaveLength(databasePlayerCount);
    expect(request.playerPool.players).toEqual(expect.arrayContaining([{
      id: targetPlayerId,
      nickname: String(targetPlayer.nickname),
      nationality: String(targetPlayer.nationality),
      region: String(targetPlayer.region),
      team: String(targetPlayer.team),
      teamHistory: JSON.parse(String(targetPlayer.team_history)),
      age: Number(targetPlayer.age),
      role: String(targetPlayer.role),
      majorChampionships: Number(targetPlayer.major_championships),
      majorAppearances: Number(targetPlayer.major_appearances),
      isActive: Boolean(targetPlayer.is_active),
      isEnabled: Boolean(targetPlayer.is_enabled),
      difficulties: targetDifficulties.map(String),
      createdAt: new Date(String(targetPlayer.created_at)).toISOString(),
    }]));

    const match = request.matches.find((item: { recordId: number }) => item.recordId === matchId);
    expect(match).toMatchObject({
      mode: 'normal',
      boType: 3,
      result: 'won',
      finishReason: 'score',
      finishedAt: expect.any(String),
    });
    expect(match.participants).toHaveLength(2);
    const subjectParticipant = match.participants.find((participant: { isSubject: boolean }) => participant.isSubject);
    const opponentParticipant = match.participants.find((participant: { isSubject: boolean }) => !participant.isSubject);
    expect(subjectParticipant).toEqual({
      participantId: request.subject.opaqueId,
      isSubject: true,
      score: 2,
      isWinner: true,
      winningGuessSum: 2,
      winningRounds: 1,
    });
    expect(opponentParticipant).toEqual(expect.objectContaining({
      participantId: expect.any(String),
      isSubject: false,
      score: 1,
      isWinner: false,
    }));
    expect(match.winnerParticipantId).toBe(request.subject.opaqueId);
    expect(match.rounds).toEqual([expect.objectContaining({
      round: 1,
      targetPlayerId,
      winnerParticipantId: request.subject.opaqueId,
      reason: 'guessed',
      guessesByParticipant: {
        [request.subject.opaqueId]: [guessPlayerId, targetPlayerId],
        [opponentParticipant.participantId]: [targetPlayerId],
      },
      guessTimesMsByParticipant: {
        [request.subject.opaqueId]: [900, 1750],
        [opponentParticipant.participantId]: [1250],
      },
    })]);
    expect(capturedBody).not.toContain(`u:${userId}`);
    expect(capturedBody).not.toContain(opponentKey);
    expect(capturedBody).not.toContain('private opponent name');
    expect(capturedBody).not.toContain('@example.com');
    expect(result.decision.level).toBe('high');
    expect(result.decision.score).toBe(92);
  });

  it('sends only the latest 50 completed single-player and multiplayer records', async () => {
    const token = 'analysis-test-token';
    const prefix = `external-analysis-limit-${Date.now()}`;
    const subjectKey = `u:${userId}`;
    const baseTime = Date.now() + 60_000;
    Object.assign(config.cheatAnalysis, {
      apiUrl: 'https://analysis.example.test/v1/analyze',
      apiToken: token,
      timeoutMs: 5_000,
    });

    const singleRows = Array.from({ length: 51 }, (_, index) => ({
      session_id: `${prefix}-single-${index}`,
      user_id: userId,
      target_player_id: targetPlayerId,
      mode: 'normal',
      guesses: JSON.stringify([targetPlayerId]),
      guess_times: JSON.stringify([1000 + index]),
      first_guess_player_id: targetPlayerId,
      status: 'won',
      guess_count: 1,
      created_at: new Date(baseTime + index * 1000 - 500),
      finished_at: new Date(baseTime + index * 1000),
    }));
    const matchRows = Array.from({ length: 51 }, (_, index) => ({
      room_id: `${prefix}-match-${index}`,
      db_type: 'normal',
      bo_type: 1,
      winner_id: userId,
      winner_key: subjectKey,
      finish_reason: 'score',
      replay: JSON.stringify([{
        round: 1,
        targetPlayerId,
        winnerKey: subjectKey,
        reason: 'guessed',
        guessesByPlayer: { [subjectKey]: [targetPlayerId] },
        guessTimesByPlayer: { [subjectKey]: [1000 + index] },
      }]),
      created_at: new Date(baseTime + index * 1000),
    }));

    try {
      await db('games').insert(singleRows);
      await db('match_records').insert(matchRows);
      const insertedMatches = await db('match_records')
        .where('room_id', 'like', `${prefix}-match-%`)
        .select('id');
      await db('match_players').insert(insertedMatches.map((match) => ({
        match_id: match.id,
        user_id: userId,
        player_key: subjectKey,
        player_name: 'private subject name',
        score: 1,
        is_winner: true,
        winning_guess_sum: 1,
        winning_rounds: 1,
      })));

      let capturedBody = '';
      vi.stubGlobal('fetch', vi.fn(async (_url: string, init?: RequestInit) => {
        capturedBody = String(init?.body ?? '');
        const request = JSON.parse(capturedBody);
        const responseBody = JSON.stringify({
          schemaVersion: 1,
          requestId: request.requestId,
          analysisId: 'analysis-limit-result',
          modelVersion: '2026.08.1',
          generatedAt: '2026-08-02T12:00:00.000Z',
          decision: { level: 'low', score: 10, label: 'Low risk', summary: 'No strong signal.' },
          sections: [],
        });
        expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${token}`);
        return new Response(responseBody, { status: 200 });
      }));

      await requestExternalCheatAnalysis(
        { type: 'user', userId, identityKey: subjectKey },
        'en-US',
        'user-detail'
      );

      const request = JSON.parse(capturedBody);
      const oldestSingle = await db('games').where({ session_id: `${prefix}-single-0` }).first('id');
      const newestSingle = await db('games').where({ session_id: `${prefix}-single-50` }).first('id');
      const oldestMatch = await db('match_records').where({ room_id: `${prefix}-match-0` }).first('id');
      const newestMatch = await db('match_records').where({ room_id: `${prefix}-match-50` }).first('id');
      expect(request.singleGames).toHaveLength(50);
      expect(request.matches).toHaveLength(50);
      expect(request.singleGames.map((game: { recordId: number }) => game.recordId)).toContain(Number(newestSingle.id));
      expect(request.singleGames.map((game: { recordId: number }) => game.recordId)).not.toContain(Number(oldestSingle.id));
      expect(request.matches.map((match: { recordId: number }) => match.recordId)).toContain(Number(newestMatch.id));
      expect(request.matches.map((match: { recordId: number }) => match.recordId)).not.toContain(Number(oldestMatch.id));
    } finally {
      await db('games').where('session_id', 'like', `${prefix}-single-%`).del();
      await db('match_records').where('room_id', 'like', `${prefix}-match-%`).del();
    }
  });

  it('rejects a response with a mismatched request id', async () => {
    Object.assign(config.cheatAnalysis, {
      apiUrl: 'https://analysis.example.test/v1/analyze',
      apiToken: 'analysis-test-token',
      timeoutMs: 5_000,
    });
    vi.stubGlobal('fetch', vi.fn(async () => {
      return new Response(JSON.stringify({
        schemaVersion: 1,
        requestId: '11111111-1111-4111-8111-111111111111',
        analysisId: 'analysis-result-2',
        modelVersion: '2026.08.1',
        generatedAt: '2026-08-02T12:00:00.000Z',
        decision: { level: 'low', score: 12, label: 'Low risk', summary: 'No strong signal.' },
        sections: [],
      }), { status: 200 });
    }));

    await expect(requestExternalCheatAnalysis(
      { type: 'user', userId, identityKey: `u:${userId}` },
      'en-US',
      'user-detail'
    )).rejects.toMatchObject<HttpError>({
      status: 502,
      code: 'ANALYSIS_SERVICE_INVALID_RESPONSE',
    });
  });
});
