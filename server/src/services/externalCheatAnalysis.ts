import crypto from 'crypto';
import { z } from 'zod';
import { config } from '../config';
import { db } from '../db/knex';
import { HttpError } from '../middleware/common';
import { getPublicPlayerList } from './playerCache';

const MAX_SINGLE_GAMES = 50;
const MAX_MATCHES = 50;
const MAX_ROUNDS_PER_MATCH = 50;
const MAX_GUESSES_PER_ROUND = 8;
const MAX_REQUEST_BYTES = 8 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;

const severitySchema = z.enum(['neutral', 'info', 'success', 'warning', 'danger']);
const displayPrimitiveSchema = z.union([
  z.string().max(500),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const labelSchema = z.string().trim().min(1).max(120);

const metricItemSchema = z.object({
  type: z.literal('metric'),
  label: labelSchema,
  value: displayPrimitiveSchema,
  displayValue: z.string().max(200).optional(),
  severity: severitySchema.optional(),
}).strict();

const textItemSchema = z.object({
  type: z.literal('text'),
  label: labelSchema,
  displayValue: z.string().max(2000),
  severity: severitySchema.optional(),
}).strict();

const badgeItemSchema = z.object({
  type: z.literal('badge'),
  label: labelSchema,
  displayValue: z.string().max(120),
  severity: severitySchema.optional(),
}).strict();

const tableItemSchema = z.object({
  type: z.literal('table'),
  label: labelSchema,
  columns: z.array(z.object({
    key: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_]{0,31}$/),
    label: labelSchema,
  }).strict()).min(1).max(12),
  rows: z.array(z.record(displayPrimitiveSchema)).max(100),
  severity: severitySchema.optional(),
}).strict();

const timelineItemSchema = z.object({
  type: z.literal('timeline'),
  label: labelSchema,
  entries: z.array(z.object({
    label: labelSchema,
    time: z.string().max(80).optional(),
    description: z.string().max(1000).optional(),
    severity: severitySchema.optional(),
  }).strict()).max(100),
  severity: severitySchema.optional(),
}).strict();

const distributionItemSchema = z.object({
  type: z.literal('distribution'),
  label: labelSchema,
  unit: z.string().max(32).optional(),
  points: z.array(z.object({
    label: z.string().max(80),
    value: z.number().finite(),
  }).strict()).max(100),
  severity: severitySchema.optional(),
}).strict();

export const externalAnalysisResponseSchema = z.object({
  schemaVersion: z.literal(1),
  requestId: z.string().uuid(),
  analysisId: z.string().trim().min(1).max(128),
  modelVersion: z.string().trim().min(1).max(64),
  generatedAt: z.string().datetime({ offset: true }),
  decision: z.object({
    level: z.enum(['unknown', 'low', 'medium', 'high', 'critical']),
    score: z.number().int().min(0).max(100),
    label: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(2000),
  }).strict(),
  sections: z.array(z.object({
    title: z.string().trim().min(1).max(120),
    items: z.array(z.discriminatedUnion('type', [
      metricItemSchema,
      textItemSchema,
      badgeItemSchema,
      tableItemSchema,
      timelineItemSchema,
      distributionItemSchema,
    ])).max(100),
  }).strict()).max(20),
}).strict();

export type ExternalAnalysisView = z.infer<typeof externalAnalysisResponseSchema>;
export type AnalysisLocale = 'zh-CN' | 'en-US' | 'ja-JP';
export type AnalysisTrigger = 'user-detail' | 'guest-detail' | 'report';

export type AnalysisSubject =
  | { type: 'user'; userId: number; identityKey: string }
  | { type: 'guest'; guestKey: string; identityKey: string };

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== 'string') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function safeGuessIds(value: unknown): number[] {
  return parseArray(value)
    .slice(0, MAX_GUESSES_PER_ROUND)
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item > 0);
}

function safeGuessTimes(value: unknown): Array<number | null> {
  return parseArray(value)
    .slice(0, MAX_GUESSES_PER_ROUND)
    .map((item) => {
      if (item == null) return null;
      const number = Number(item);
      return Number.isFinite(number) && number >= 0 ? Math.floor(number) : null;
    });
}

function isoTimestamp(value: unknown): string {
  const numericValue = typeof value === 'number'
    ? value
    : typeof value === 'string' && /^\d+$/.test(value)
      ? Number(value)
      : null;
  const date = value instanceof Date
    ? value
    : numericValue == null
      ? new Date(String(value))
      : new Date(numericValue);
  return date.toISOString();
}

async function readBoundedResponse(response: Response): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new HttpError(502, 'ANALYSIS_SERVICE_INVALID_RESPONSE');
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function buildSnapshot(subject: AnalysisSubject, locale: AnalysisLocale, trigger: AnalysisTrigger) {
  const singleQuery = db('games')
    .whereNotNull('finished_at')
    .orderBy('finished_at', 'desc')
    .orderBy('id', 'desc')
    .limit(MAX_SINGLE_GAMES)
    .select(
      'id',
      'target_player_id as targetPlayerId',
      'mode',
      'guesses',
      'guess_times as guessTimes',
      'status',
      'guess_count as guessCount',
      'first_guess_player_id as firstGuessPlayerId',
      'created_at as createdAt',
      'finished_at as finishedAt'
    );
  if (subject.type === 'user') singleQuery.where('user_id', subject.userId);
  else singleQuery.where('guest_key', subject.guestKey);

  const matchQuery = db('match_records as m')
    .join('match_players as mp', 'mp.match_id', 'm.id')
    .where('mp.player_key', subject.identityKey)
    .orderBy('m.created_at', 'desc')
    .orderBy('m.id', 'desc')
    .limit(MAX_MATCHES)
    .select(
      'm.id',
      'm.db_type as mode',
      'm.bo_type as boType',
      'm.winner_key as winnerKey',
      'm.finish_reason as finishReason',
      'm.forfeited_key as forfeitedKey',
      'm.replay',
      'm.created_at as finishedAt',
      'mp.player_key as playerKey'
    );

  const reportBase = db('match_reports').where('reported_key', subject.identityKey);
  const [
    singleRows,
    matchRows,
    reportTotals,
    pendingReports,
    playerList,
    playerRows,
    difficultyRows,
  ] = await Promise.all([
    singleQuery,
    matchQuery,
    reportBase.clone().count({ count: 'id' }).countDistinct({ reporters: 'reporter_key' }).first(),
    reportBase.clone().where('status', 'pending').count({ count: 'id' }).first(),
    getPublicPlayerList(),
    db('players').orderBy('id').select(
      'id',
      'nickname',
      'nationality',
      'region',
      'team',
      'age',
      'role',
      'major_championships as majorChampionships',
      'major_appearances as majorAppearances',
      'is_active as isActive',
      'is_enabled as isEnabled',
      'created_at as createdAt'
    ),
    db('player_difficulties').select('player_id as playerId', 'difficulty_key as difficultyKey'),
  ]);

  const matchIds = matchRows.map((row) => Number(row.id));
  const participantRows = matchIds.length
    ? await db('match_players')
      .whereIn('match_id', matchIds)
      .orderBy('match_id')
      .orderBy('id')
      .select(
        'id',
        'match_id as matchId',
        'player_key as playerKey',
        'score',
        'is_winner as isWinner',
        'winning_guess_sum as winningGuessSum',
        'winning_rounds as winningRounds'
      )
    : [];

  const subjectOpaqueId = crypto.randomUUID();
  const identityMap = new Map<string, string>([[subject.identityKey, subjectOpaqueId]]);
  const opaqueIdentity = (identityKey: unknown): string | null => {
    if (typeof identityKey !== 'string' || !identityKey) return null;
    const existing = identityMap.get(identityKey);
    if (existing) return existing;
    const opaqueId = crypto.randomUUID();
    identityMap.set(identityKey, opaqueId);
    return opaqueId;
  };
  const participantsByMatch = new Map<number, typeof participantRows>();
  for (const participant of participantRows) {
    const matchId = Number(participant.matchId);
    const list = participantsByMatch.get(matchId) ?? [];
    list.push(participant);
    participantsByMatch.set(matchId, list);
  }

  const difficultiesByPlayer = new Map<number, string[]>();
  for (const membership of difficultyRows) {
    const playerId = Number(membership.playerId);
    const difficulties = difficultiesByPlayer.get(playerId) ?? [];
    difficulties.push(String(membership.difficultyKey));
    difficultiesByPlayer.set(playerId, difficulties);
  }
  const players = playerRows.map((player) => ({
    id: Number(player.id),
    nickname: String(player.nickname),
    nationality: String(player.nationality),
    region: String(player.region),
    team: String(player.team),
    age: Number(player.age),
    role: String(player.role),
    majorChampionships: Number(player.majorChampionships),
    majorAppearances: Number(player.majorAppearances),
    isActive: Boolean(player.isActive),
    isEnabled: Boolean(player.isEnabled),
    difficulties: (difficultiesByPlayer.get(Number(player.id)) ?? []).sort(),
    createdAt: isoTimestamp(player.createdAt),
  }));

  const singleGames = singleRows.map((row) => ({
    recordId: Number(row.id),
    targetPlayerId: Number(row.targetPlayerId),
    mode: String(row.mode),
    status: String(row.status),
    guessCount: Number(row.guessCount),
    firstGuessPlayerId: row.firstGuessPlayerId == null ? null : Number(row.firstGuessPlayerId),
    guessPlayerIds: safeGuessIds(row.guesses),
    guessTimesMs: safeGuessTimes(row.guessTimes),
    startedAt: isoTimestamp(row.createdAt),
    finishedAt: isoTimestamp(row.finishedAt),
  }));

  const matches = matchRows.map((row) => {
    const participants = (participantsByMatch.get(Number(row.id)) ?? []).map((participant) => ({
      participantId: opaqueIdentity(participant.playerKey) as string,
      isSubject: participant.playerKey === subject.identityKey,
      score: Number(participant.score),
      isWinner: Boolean(participant.isWinner),
      winningGuessSum: Number(participant.winningGuessSum),
      winningRounds: Number(participant.winningRounds),
    }));
    const rounds = parseArray(row.replay).slice(0, MAX_ROUNDS_PER_MATCH).flatMap((value) => {
      if (!value || typeof value !== 'object') return [];
      const stored = value as Record<string, unknown>;
      const guessesByPlayer = stored.guessesByPlayer && typeof stored.guessesByPlayer === 'object'
        ? stored.guessesByPlayer as Record<string, unknown>
        : {};
      const guessTimesByPlayer = stored.guessTimesByPlayer && typeof stored.guessTimesByPlayer === 'object'
        ? stored.guessTimesByPlayer as Record<string, unknown>
        : {};
      const targetPlayerId = Number(stored.targetPlayerId);
      if (!Number.isInteger(targetPlayerId) || targetPlayerId <= 0) return [];
      const guessesByParticipant = Object.fromEntries(
        Object.entries(guessesByPlayer).flatMap(([identityKey, guesses]) => {
          const participantId = opaqueIdentity(identityKey);
          return participantId ? [[participantId, safeGuessIds(guesses)]] : [];
        })
      );
      const guessTimesMsByParticipant = Object.fromEntries(
        Object.entries(guessTimesByPlayer).flatMap(([identityKey, guessTimes]) => {
          const participantId = opaqueIdentity(identityKey);
          return participantId ? [[participantId, safeGuessTimes(guessTimes)]] : [];
        })
      );
      return [{
        round: Number.isInteger(Number(stored.round)) ? Number(stored.round) : 0,
        targetPlayerId,
        winnerParticipantId: opaqueIdentity(stored.winnerKey),
        reason: typeof stored.reason === 'string' ? stored.reason.slice(0, 32) : '',
        guessesByParticipant,
        guessTimesMsByParticipant,
      }];
    });
    return {
      recordId: Number(row.id),
      mode: String(row.mode),
      boType: Number(row.boType),
      result: row.winnerKey === row.playerKey ? 'won' : row.winnerKey ? 'lost' : 'draw',
      winnerParticipantId: opaqueIdentity(row.winnerKey),
      forfeitedParticipantId: opaqueIdentity(row.forfeitedKey),
      finishReason: typeof row.finishReason === 'string' ? row.finishReason.slice(0, 32) : '',
      finishedAt: isoTimestamp(row.finishedAt),
      participants,
      rounds,
    };
  });

  return {
    schemaVersion: 1 as const,
    requestId: crypto.randomUUID(),
    generatedAt: new Date().toISOString(),
    locale,
    trigger,
    subject: {
      type: subject.type,
      opaqueId: subjectOpaqueId,
    },
    playerPool: { revision: playerList.version, players },
    singleGames,
    matches,
    reports: {
      count: Number(reportTotals?.count ?? 0),
      independentReporters: Number(reportTotals?.reporters ?? 0),
      pending: Number(pendingReports?.count ?? 0),
    },
  };
}

export async function requestExternalCheatAnalysis(
  subject: AnalysisSubject,
  locale: AnalysisLocale,
  trigger: AnalysisTrigger
): Promise<ExternalAnalysisView> {
  if (!config.cheatAnalysis.apiUrl || !config.cheatAnalysis.apiToken) {
    throw new HttpError(503, 'ANALYSIS_SERVICE_NOT_CONFIGURED');
  }
  const snapshot = await buildSnapshot(subject, locale, trigger);
  const body = JSON.stringify(snapshot);
  if (Buffer.byteLength(body, 'utf8') > MAX_REQUEST_BYTES) {
    throw new HttpError(413, 'ANALYSIS_SNAPSHOT_TOO_LARGE');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.cheatAnalysis.timeoutMs);
  timer.unref?.();
  let response: Response;
  try {
    response = await fetch(config.cheatAnalysis.apiUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        Authorization: `Bearer ${config.cheatAnalysis.apiToken}`,
      },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new HttpError(504, 'ANALYSIS_SERVICE_TIMEOUT');
    }
    throw new HttpError(502, 'ANALYSIS_SERVICE_UNAVAILABLE');
  } finally {
    clearTimeout(timer);
  }

  const responseText = await readBoundedResponse(response);
  if (!response.ok) throw new HttpError(502, 'ANALYSIS_SERVICE_UNAVAILABLE');

  let parsed: unknown;
  try {
    parsed = JSON.parse(responseText);
  } catch {
    throw new HttpError(502, 'ANALYSIS_SERVICE_INVALID_RESPONSE');
  }
  const result = externalAnalysisResponseSchema.safeParse(parsed);
  if (!result.success || result.data.requestId !== snapshot.requestId) {
    throw new HttpError(502, 'ANALYSIS_SERVICE_INVALID_RESPONSE');
  }
  return result.data;
}
