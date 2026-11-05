import { beforeAll, afterAll, describe, it, expect } from "vitest";
import { randomUUID } from "crypto";
import { db } from "../../src/db/knex";
import { ensureSchema } from "../../src/db/schema";
import { submitCareer, reviewCareer, type Career } from "../../src/card-link/careers";
import { exportPlayers } from "../../src/services/playerExport";
import { importPlayers, playerImportSchema, playerUpdateSchema } from "../../src/services/playerMutations";
import { queryPlayerTimelineAt } from "../../src/card-link/timelineQuery";
let playerId: number;
const data: Career = { personKey: "export:1", page: "https://example.com/1", sourceRevision: "r1", observedAt: "2026-10-24", aliases: [], locked: false, tenures: [{ team: "A", teamId: "A", game: "csgo", start: "2013-12-31", end: "2014-01-01", precision: "year", status: "active", rawDates: "2013 — 2014", source: "https://example.com/1", verified: false }] };
beforeAll(async () => {
  if (!process.env.DB_URL?.includes("verification")) throw Error("ISOLATED_DB_REQUIRED");
  await ensureSchema();
  const [row] = await db("players").insert({ nickname: "career-export-fixture", nationality: "Sweden", age: 25, team_history: '["Legacy"]' }).returning("id");
  playerId = Number(row.id);
  await db("player_difficulties").insert({ player_id: playerId, difficulty_key: "normal" });
});
afterAll(async () => { await db.destroy(); });
describe("career JSON and incremental persistence", () => {
  it('keeps omitted update and legacy history fields absent after validator upgrades', () => {
    expect(playerUpdateSchema.parse({ age: 27 })).toEqual({ age: 27 });
    expect(playerUpdateSchema.safeParse({}).success).toBe(false);
    const [legacy] = playerImportSchema.parse({ players: [{ nickname: 'legacy-import', nationality: 'Sweden', age: 27 }] }).players;
    expect(legacy).not.toHaveProperty('team_history');
    expect(legacy).not.toHaveProperty('is_enabled');
    expect(playerImportSchema.safeParse({ players: Array(1001).fill(null) }).success).toBe(false);
  });
  it('rejects conflicting stable IDs even without a career and rolls back the whole import', async () => {
    const [a, b] = await db('players').insert([
      { nickname: 'import-identity-a', nationality: 'Sweden', age: 25 },
      { nickname: 'import-identity-b', nationality: 'Sweden', age: 26 },
    ]).returning('*');
    const catalog = await db('card_catalog').where({ id: 1 }).first();
    for (const career of [undefined, null, data]) {
      const rows = playerImportSchema.parse({ players: [
        { nickname: a.nickname, playerId: Number(a.id), nationality: 'Sweden', age: 40 },
        { nickname: b.nickname, playerId: Number(a.id), nationality: 'Sweden', age: 41, career },
      ] }).players;
      await expect(importPlayers(rows, 1)).rejects.toMatchObject({ code: 'PLAYER_TARGET_MISMATCH' });
      expect(await db('players').where({ id: a.id }).first()).toEqual(a);
      expect(await db('players').where({ id: b.id }).first()).toEqual(b);
      expect(await db('card_catalog').where({ id: 1 }).first()).toEqual(catalog);
    }
  });
  it('does not fork a renamed player when an older export still carries its stable ID', async () => {
    const [a] = await db('players').insert({ nickname: 'import-renamed-now', nationality: 'Sweden', age: 25 }).returning('*');
    for (const career of [undefined, data]) {
      const rows = playerImportSchema.parse({ players: [
        { playerId: Number(a.id), nickname: 'import-renamed-before', nationality: 'Sweden', age: 25, career },
      ] }).players;
      await expect(importPlayers(rows, 1)).rejects.toMatchObject({ code: 'PLAYER_TARGET_MISMATCH' });
      expect(await db('players').where({ nickname: 'import-renamed-before' }).first()).toBeUndefined();
      expect(await db('players').where({ id: a.id }).first()).toEqual(a);
    }
    const legacy = playerImportSchema.parse({ players: [{ nickname: a.nickname, nationality: 'Sweden', age: 26 }] }).players;
    expect(await importPlayers(legacy, 1)).toMatchObject({ created: 0, updated: 1 });
    expect((await db('players').where({ id: a.id }).first()).age).toBe(26);
  });
  it("queues a transfer then changes only its affected tenure after approval", async () => {
    const [player] = await db('players').insert({ nickname: 'transfer-' + randomUUID().slice(0, 8), nationality: 'Sweden', age: 25 }).returning('id');
    const pid = Number(player.id);
    const before = structuredClone(data);
    before.tenures[0] = { ...before.tenures[0], start: '2020-01-01', end: '2026-10-25', precision: 'day', rawDates: '2020-01-01 — Present' };
    let receipt = await submitCareer({ playerId: pid, expectedRevision: 0, career: before }, 'token:1', randomUUID());
    await reviewCareer(receipt.id, true, 1);
    const manual = structuredClone(before); manual.tenures[0].start = '2020-02-01';
    receipt = await submitCareer({ playerId: pid, expectedRevision: 1, career: manual }, 'admin:1', randomUUID());
    await reviewCareer(receipt.id, true, 1);
    const preserved = await db('card_careers').where({ player_id: pid }).first();
    const incoming = structuredClone(before);
    incoming.tenures[0].end = '2026-10-20'; incoming.tenures[0].rawDates = '2020-01-01 — 2026-10-20';
    incoming.tenures.push({ ...incoming.tenures[0], teamId: 'B', team: 'B', start: '2026-10-21', end: '2026-10-25', rawDates: '2026-10-21 — Present' });
    receipt = await submitCareer({ playerId: pid, expectedRevision: 2, career: incoming }, 'token:1', randomUUID());
    expect(receipt.status).toBe('pending');
    expect(await db('card_careers').where({ player_id: pid }).first()).toEqual(preserved);
    expect((await queryPlayerTimelineAt(pid, '2026-10-22'))!.teams.map(t => t.teamId)).toEqual(['A']);
    await reviewCareer(receipt.id, true, 1);
    expect((await queryPlayerTimelineAt(pid, '2026-10-22'))!.teams.map(t => t.teamId)).toEqual(['B']);
    const rows = await db('card_career_tenures').where({ player_id: pid }).orderBy('ordinal');
    expect(rows.map(r => JSON.parse(r.payload))).toMatchObject([
      { teamId: 'A', start: '2020-02-01', end: '2026-10-20' },
      { teamId: 'B', start: '2026-10-21' },
    ]);
    expect((await submitCareer({ playerId: pid, expectedRevision: 3, career: incoming }, 'token:1', randomUUID())).status).toBe('unchanged');
  });
  it("exports approved dates and protected evidence; reimport is lossless and idempotent", async () => {
    let review = await submitCareer({ playerId, expectedRevision: 0, career: data }, "source", randomUUID());
    await reviewCareer(review.id, true, 1);
    const edited = structuredClone(data);
    edited.tenures[0].start = "2013-05-31";
    edited.tenures[0].precision = "month";
    edited.tenures[0].manual = { fields: ["start", "precision"], source: "https://www.hltv.org/player/1/example", checkedAt: "2026-10-24", note: "May 2013 - Jan 2014" };
    review = await submitCareer({ playerId, expectedRevision: 1, career: edited }, "admin:1", randomUUID());
    await reviewCareer(review.id, true, 1);
    const exported = (await exportPlayers()).find(p => p.playerId === playerId)!;
    expect(exported.team_history).toEqual(["Legacy"]);
    expect(exported.career_revision).toBe(2);
    expect(exported.career?.tenures[0].start).toBe("2013-05-31");
    expect(exported.career?.tenures[0].manual?.source).toContain("hltv.org");
    expect(exported.career?.tenures[0].sourceSnapshot?.start).toBe("2013-12-31");
    const before = await db("card_careers").where({ player_id: playerId }).first();
    const count = Number((await db("card_career_reviews").count("* as n").first())!.n);
    await importPlayers(playerImportSchema.parse({ players: JSON.parse(JSON.stringify([exported])) }).players, 1);
    expect(await db("card_careers").where({ player_id: playerId }).first()).toEqual(before);
    expect(Number((await db("card_career_reviews").count("* as n").first())!.n)).toBe(count);
    const result = await submitCareer({ playerId, expectedRevision: 2, career: data }, "token:1", randomUUID());
    expect(result.status).toBe("unchanged");
    expect(await db("card_careers").where({ player_id: playerId }).first()).toEqual(before);
  });
  it("queues edited backup careers, keeps original revision conflicts, and preserves rows for old exports", async () => {
    const exported = (await exportPlayers()).find(p => p.playerId === playerId)!;
    exported.career!.tenures[0].end = "2014-02-01";
    exported.career_revision = 1;
    const result = await importPlayers(playerImportSchema.parse({ players: [exported] }).players, 1);
    expect(result.careerReviews).toBe(1);
    const review = await db("card_career_reviews").where({ source: "admin:1:json-import" }).first();
    expect(review.status).toBe("conflict");
    expect((await reviewCareer(review.id, true, 1)).status).toBe("conflict");
    const { career, career_revision, ...legacy } = exported;
    await importPlayers(playerImportSchema.parse({ players: [legacy] }).players, 1);
    expect(JSON.parse((await db("card_careers").where({ player_id: playerId }).first()).payload).tenures[0].end).toBe("2014-01-01");
  });
});
