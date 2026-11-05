import knex from "knex";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSchema } from "../../src/db/schema";
import { assertDatabaseReady } from "../../src/db/ready";
import { backfillCareerTenures } from "../../src/card-link/careerMigration";
import { queryPlayerTimelineAt } from "../../src/card-link/timelineQuery";
import type { Career } from "../../src/card-link/careers";

const instances: ReturnType<typeof knex>[] = [];
afterEach(async () => { await Promise.all(instances.splice(0).map(k => k.destroy())); });
const data: Career = {
  personKey: "fixture:1", page: "https://example.com/p", sourceRevision: "1",
  observedAt: "2020-12-31", locked: false, aliases: [],
  tenures: ["A", "B", "A"].map((team, i) => ({
    team, teamId: team, game: "csgo", start: `2020-0${i + 1}-01`, end: `2020-0${i + 2}-01`,
    precision: "day", status: "active", rawDates: `original ${i}`, verified: false,
    source: "https://example.com/p",
  })),
};
async function fixture() {
  const k = knex({ client: "better-sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  instances.push(k);
  await ensureSchema(k);
  await k("players").insert([
    { id: 1, nickname: "legacy", nationality: "Sweden", age: 25, team: "A", team_history: '[ "A", "B", "A" ]', is_enabled: true },
    { id: 2, nickname: "dated", nationality: "Sweden", age: 25, team: "B", team_history: '["B"]', is_enabled: true },
    { id: 3, nickname: "disabled-peer", nationality: "Sweden", age: 25, team: "A", team_history: '[]', is_enabled: false },
  ]);
  await k("card_careers").insert([
    { player_id: 2, revision: 7, payload: JSON.stringify(data, null, 2) },
    { player_id: 3, revision: 1, payload: JSON.stringify({ ...data, personKey: "fixture:2" }) },
  ]);
  return k;
}

describe("additive career timeline migration", () => {
  it('adds rollout controls and publication evidence without publishing candidates or changing frozen payloads', async () => {
    const k = await fixture();
    for (const version of ['active', 'history', 'candidate']) await k('card_graphs').insert({ version, source_revision: 1, payload: JSON.stringify({ version }), created_at: 123 });
    await k('card_catalog').where({ id: 1 }).update({ graph_version: 'active', enabled: false });
    await k('card_daily').insert({ day: '2026-10-24', variant: 'limited', payload: JSON.stringify([{ graphVersion: 'history' }]) });
    const frozen = await k('card_graphs').select('version', 'payload', 'source_revision').orderBy('version');
    const daily = await k('card_daily');
    await k.schema.alterTable('card_graphs', t => { t.dropColumn('source_hash'); t.dropColumn('published_at'); });
    await k.schema.alterTable('card_catalog', t => { for (const scene of ['practice', 'daily', 'friend', 'ranked']) t.dropColumn(`${scene}_enabled`); });
    await k.schema.dropTable('card_admin_events');
    await expect(assertDatabaseReady(k)).rejects.toThrow();
    await ensureSchema(k); await assertDatabaseReady(k);
    const catalog = await k('card_catalog').where({ id: 1 }).first();
    expect(Boolean(catalog.enabled)).toBe(false);
    for (const scene of ['practice', 'daily', 'friend', 'ranked']) expect(Boolean(catalog[`${scene}_enabled`])).toBe(true);
    expect((await k('card_graphs').where({ version: 'active' }).first()).published_at).toBe(123);
    expect((await k('card_graphs').where({ version: 'history' }).first()).published_at).toBe(123);
    expect((await k('card_graphs').where({ version: 'candidate' }).first()).published_at).toBeNull();
    const after = await k('card_graphs').orderBy('version');
    await ensureSchema(k);
    expect(await k('card_graphs').orderBy('version')).toEqual(after);
    expect(await k('card_graphs').select('version', 'payload', 'source_revision').orderBy('version')).toEqual(frozen);
    expect(await k('card_daily')).toEqual(daily);
    expect(await k('card_admin_events')).toEqual([]);
  });
  it("creates an absent index, backfills approved JSON only, and preserves all old facts on rerun", async () => {
    const k = await fixture();
    const playersBefore = await k("players").orderBy("id");
    const careersBefore = await k("card_careers").orderBy("player_id");
    const catalogBefore = await k("card_catalog");
    await k("card_graphs").insert({ version: "frozen", source_revision: 7, payload: '{ "unchanged": true }', created_at: 1 });
    const graphsBefore = await k("card_graphs");
    await k.schema.dropTable("card_career_tenures");
    await expect(assertDatabaseReady(k)).rejects.toThrow("card_career_tenures");
    expect(await k.schema.hasTable("card_career_tenures")).toBe(false);
    await ensureSchema(k);
    await assertDatabaseReady(k);
    const indexed = await k("card_career_tenures").orderBy(["player_id", "ordinal"]);
    expect(indexed).toHaveLength(6);
    expect(indexed.filter(r => Number(r.player_id) === 2).map(r => r.team_id)).toEqual(["A", "B", "A"]);
    await ensureSchema(k);
    expect(await k("players").orderBy("id")).toEqual(playersBefore);
    expect(await k("card_careers").orderBy("player_id")).toEqual(careersBefore);
    expect(await k("card_catalog")).toEqual(catalogBefore);
    expect(await k("card_graphs")).toEqual(graphsBefore);
    expect(await k("card_career_tenures").orderBy(["player_id", "ordinal"])).toEqual(indexed);
    expect(await k("card_careers").where({ player_id: 1 })).toEqual([]);
  });
  it("fills partial indexes without overwriting existing rows; bad source rolls back all additions", async () => {
    const k = await fixture();
    const existing = { player_id: 2, ordinal: 0, person_key: data.personKey,
      team_id: "A", start_date: "2020-01-01", end_date: "2020-02-01", payload: JSON.stringify(data.tenures[0], null, 2) };
    await k("card_career_tenures").insert(existing);
    await k("card_careers").where({ player_id: 3 }).update({ payload: "invalid-json" });
    await expect(backfillCareerTenures(k)).rejects.toThrow();
    expect(await k("card_career_tenures")).toEqual([existing]);
    await k("card_careers").where({ player_id: 3 }).update({ payload: JSON.stringify({ ...data, personKey: "fixture:2" }) });
    await backfillCareerTenures(k);
    expect(await k("card_career_tenures").where({ player_id: 2, ordinal: 0 }).first()).toEqual(existing);
    expect(await k("card_career_tenures")).toHaveLength(6);
  });
  it("queries approved JSON read-only, includes disabled history, and never invents legacy dates", async () => {
    const k = await fixture();
    const before = await k("card_careers").orderBy("player_id");
    const statements: string[] = [];
    k.on("query", q => statements.push(q.sql));
    const result = await queryPlayerTimelineAt(2, "2020-01-10T12:00:00Z", k);
    expect(statements).toHaveLength(1);
    expect(result).toMatchObject({ day: "2020-01-10", coverage: "confirmed", teams: [{
      teamId: "A", teammates: [{ playerId: 3 }],
    }] });
    expect((await queryPlayerTimelineAt(1, "2020-01-10", k))?.coverage).toBe("missing-career");
    expect(await queryPlayerTimelineAt(999, "2020-01-10", k)).toBeNull();
    await expect(queryPlayerTimelineAt(0, "2020-01-10", k)).rejects.toThrow("INVALID_PLAYER_ID");
    await expect(queryPlayerTimelineAt(2, "2020-02-30", k)).rejects.toThrow();
    expect(await k("card_careers").orderBy("player_id")).toEqual(before);
    expect(await k("card_career_tenures")).toEqual([]);
  });
});
