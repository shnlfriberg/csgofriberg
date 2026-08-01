import { beforeAll, describe, expect, it } from 'vitest';
import { db } from '../db/knex';
import { initDb } from '../db/init';
import { persistMatchResult, type MatchResultPayload } from './matchResultQueue';

describe('match result persistence', () => {
  beforeAll(async () => {
    await initDb();
  });

  it('adds reports idempotently when they arrive after the match record', async () => {
    const stamp = Date.now();
    const recordId = `report-persistence-${stamp}`;
    const playerA = `g:report-persist-a-${stamp}`;
    const playerB = `g:report-persist-b-${stamp}`;
    const payload: MatchResultPayload = {
      recordId,
      dbType: 'easy',
      boType: 1,
      winnerKey: playerA,
      reason: 'score',
      forfeitedKey: null,
      participants: [
        { key: playerA, userId: null, name: 'A', score: 1 },
        { key: playerB, userId: null, name: 'B', score: 0 },
      ],
      rounds: [],
    };
    try {
      await persistMatchResult(payload);
      await persistMatchResult({
        ...payload,
        reports: [
          { reporterKey: playerA, reportedKey: playerB, description: 'automation', createdAt: stamp },
          { reporterKey: playerB, reportedKey: playerA, description: '', createdAt: stamp + 1 },
        ],
      });
      await persistMatchResult({
        ...payload,
        reports: [
          { reporterKey: playerA, reportedKey: playerB, description: 'automation', createdAt: stamp },
          { reporterKey: playerB, reportedKey: playerA, description: '', createdAt: stamp + 1 },
        ],
      });

      const match = await db('match_records').where({ room_id: recordId }).first('id');
      const reports = await db('match_reports').where({ match_id: match.id }).orderBy('reporter_key');
      expect(reports.map((report) => ({
        reporterKey: report.reporter_key,
        reportedKey: report.reported_key,
        description: report.description,
        status: report.status,
      }))).toEqual([
        { reporterKey: playerA, reportedKey: playerB, description: 'automation', status: 'pending' },
        { reporterKey: playerB, reportedKey: playerA, description: '', status: 'pending' },
      ]);
    } finally {
      await db('match_records').where({ room_id: recordId }).del();
    }
  });
});
