import type { Knex } from "knex";
import { effectiveTenures } from "./tenures";
import { randomInt } from "crypto";
import {
  graphIndex,
  shortestPath,
  type GraphData,
  type Graph,
  type Question,
  type Difficulty,
  type EdgeEvidence,
} from "@friberg/card-link-core";
import { db } from "../db/knex";
import { HttpError } from "../middleware/common";
import { fingerprint, lockRow, transaction } from "./transaction";
import { careerSchema, type Career } from "./careers";
import { auditOperation } from './operations';
import { observe } from './metrics';
import { performance } from 'node:perf_hooks';
type Loaded = { data: GraphData; index: Graph };
const cache = new Map<string, Promise<Loaded>>();
export async function loadGraph(
  version: string,
  reader: Knex | Knex.Transaction = db,
): Promise<Loaded> {
  if (reader !== db) {
    const row = await reader("card_graphs").where({ version }).first();
    if (!row) throw new HttpError(503, "CARD_GRAPH_MISSING");
    const data: GraphData = JSON.parse(row.payload);
    return { data, index: graphIndex(data) };
  }
  let task = cache.get(version);
  if (task) {
    observe('graph_cache_hit');
    cache.delete(version);
    cache.set(version, task);
    return task;
  }
  observe('graph_cache_miss');
  task = (async () => {
    const row = await reader("card_graphs").where({ version }).first();
    if (!row) throw new HttpError(503, "CARD_GRAPH_MISSING");
    const data: GraphData = JSON.parse(row.payload);
    return { data, index: graphIndex(data) };
  })();
  cache.set(version, task);
  if (cache.size > 8) cache.delete(cache.keys().next().value!);
  try {
    return await task;
  } catch (e) {
    cache.delete(version);
    throw e;
  }
}
export async function activeGraph() {
  const c = await db("card_catalog").where({ id: 1 }).first();
  if (!c?.enabled || !c.graph_version)
    throw new HttpError(503, "CARD_NOT_READY");
  return loadGraph(c.graph_version);
}
export function selectQuestions(
  graph: Loaded,
  difficulty: Difficulty,
  count: number,
): Question[] {
  const { data, index } = graph;
  const pairs = data.pairs[difficulty], result: Question[] = [];
  if (!Number.isSafeInteger(count) || count < 1 || count > 100 || pairs.length < count)
    throw new HttpError(409, "CARD_POOL_UNAVAILABLE");
  const bounds = difficulty === "easy" ? [2, 2] : difficulty === "normal" ? [3, 3] : [4, 5];
  // Randomly sample across the whole reservoir, not neighbouring entries from
  // one BFS source. Partial Fisher-Yates visits each candidate at most once.
  const order = Array.from({ length: pairs.length }, (_, i) => i);
  const used = new Set<string>(), usedPlayers = new Set<number>();
  const components = new Map<number, number[]>();
  const catalog = new Set(data.players.map(p => p.id));
  const deferred: Question[] = [];
  const accept = (q: Question) => {
    result.push(q); usedPlayers.add(q.start); usedPlayers.add(q.end);
  };
  const componentFor = (start: number) => {
    const cached = components.get(start);
    if (cached) return cached;
    const members = [start], seen = new Set(members);
    for (let head = 0; head < members.length; head++)
      for (const id of index.get(members[head]) ?? [])
        if (catalog.has(id) && !seen.has(id)) { seen.add(id); members.push(id); }
    for (const id of members) components.set(id, members);
    return members;
  };
  for (let i = 0; i < order.length && result.length < count; i++) {
    const pick = randomInt(i, order.length);
    [order[i], order[pick]] = [order[pick], order[i]];
    let [start, end] = pairs[order[i]];
    const key = `${Math.min(start, end)}:${Math.max(start, end)}`;
    if (used.has(key) || start === end || !catalog.has(start) || !catalog.has(end)) continue;
    used.add(key);
    const route = shortestPath(index, start, end, catalog);
    if (!route || route.length - 1 < bounds[0] || route.length - 1 > bounds[1]) continue;
    const pool = componentFor(start).filter(id => id !== start && id !== end);
    if (randomInt(2)) [start, end] = [end, start];
    const q = { graphVersion: data.version, start, end, pool };
    if (usedPlayers.has(start) || usedPlayers.has(end)) {
      deferred.push(q);
      // Diversity is a preference. Small or narrow pools must remain playable.
      if (deferred.length >= Math.max(64, count * 8)) break;
    } else accept(q);
  }
  for (const q of deferred) { if (result.length === count) break; accept(q); }
  if (result.length !== count) throw new HttpError(409, "CARD_POOL_UNAVAILABLE");
  return result;
}
export function buildGraph(
  rows: {
    id: number;
    nickname: string;
    age?: number | null;
    nationality: string;
    team: string;
    career: Career;
  }[],
): GraphData {
  const people = new Map<string, typeof rows>();
  for (const r of rows) {
    const list = people.get(r.career.personKey) ?? [];
    list.push(r);
    people.set(r.career.personKey, list);
  }
  const players = [...people.values()]
    .map((list) => {
      list.sort((a, b) => a.id - b.id);
      const p = list[0];
      return {
        id: p.id,
        nickname: p.nickname,
        age: p.age ?? null,
        nationality: p.nationality,
        team: p.team,
        aliases: [
          ...new Set(list.flatMap((x) => [x.nickname, ...x.career.aliases])),
        ],
      };
    })
    .sort((a, b) => a.id - b.id);
  type Interval = {
    id: number;
    start: string;
    end: string;
    team: string;
    sources: string[];
  };
  const groups = new Map<string, Interval[]>();
  for (const list of people.values()) {
    for (const t of effectiveTenures(
      list.flatMap((row) => row.career.tenures),
    )) {
      if (
        !t.start ||
        !t.end ||
        t.start >= t.end ||
        !(
          ["active", "loan"].includes(t.status) ||
          (["trial", "standin"].includes(t.status) && t.verified)
        )
      )
        continue;
      const key = t.teamId;
      const group = groups.get(key) ?? [];
      group.push({
        id: list[0].id,
        start: t.start,
        end: t.end,
        team: t.team,
        sources: [...new Set([t.source, ...(t.manual ? [t.manual.source] : [])])],
      });
      groups.set(key, group);
    }
  }
  const edges = new Map<
    string,
    { a: number; b: number; evidence: EdgeEvidence[] }
  >();
  for (const group of groups.values()) {
    group.sort((a, b) => a.start.localeCompare(b.start));
    let active: Interval[] = [];
    for (const entry of group) {
      active = active.filter((t) => t.end > entry.start);
      for (const t of active) {
        if (t.id === entry.id) continue;
        const a = Math.min(t.id, entry.id),
          b = Math.max(t.id, entry.id),
          key = `${a}:${b}`;
        const edge = edges.get(key) ?? { a, b, evidence: [] };
        const evidence = {
          team: entry.team,
          start: entry.start,
          end: t.end < entry.end ? t.end : entry.end,
          sources: [...new Set([...t.sources, ...entry.sources])].sort(),
        };
        if (
          !edge.evidence.some(
            (e) => JSON.stringify(e) === JSON.stringify(evidence),
          )
        )
          edge.evidence.push(evidence);
        edges.set(key, edge);
      }
      active.push(entry);
    }
  }
  const data: GraphData = {
    version: "",
    players,
    edges: [...edges.values()].sort((a, b) => a.a - b.a || a.b - b.b),
    pairs: { easy: [], normal: [], hard: [] },
  };
  const index = graphIndex(data);
  // Endpoint candidates are a bounded deterministic reservoir, not an all-pairs
  // path table. A hard exploration budget also bounds dense large catalogs.
  const counts = { easy: 0, normal: 0, hard: 0 };
  let rng = 0x6d2b79f5,
    work = 0;
  const sample = (difficulty: Difficulty, pair: [number, number]) => {
    const count = ++counts[difficulty],
      pool = data.pairs[difficulty];
    if (pool.length < 20000) {
      pool.push(pair);
      return;
    }
    rng ^= rng << 13;
    rng ^= rng >>> 17;
    rng ^= rng << 5;
    const slot = Math.floor(((rng >>> 0) / 4294967296) * count);
    if (slot < pool.length) pool[slot] = pair;
  };
  sources: for (const p of players) {
    const queue = [p.id],
      distance = new Map([[p.id, 0]]);
    for (let head = 0; head < queue.length; head++) {
      const id = queue[head],
        d = distance.get(id)!;
      if (d >= 5) continue;
      for (const n of index.get(id) ?? []) {
        if (++work > 20000000) break sources;
        if (!distance.has(n)) {
          distance.set(n, d + 1);
          queue.push(n);
          if (n > p.id && d + 1 >= 2)
            sample(d + 1 === 2 ? "easy" : d + 1 === 3 ? "normal" : "hard", [
              p.id,
              n,
            ]);
        }
      }
    }
  }
  data.version = fingerprint(data);
  return data;
}
// Explicit build command; never called by a gameplay request.
async function sourceRows(trx: Knex.Transaction) {
  return (await trx('players as p').join('card_careers as c', 'p.id', 'c.player_id')
    .where('p.is_enabled', true).orderBy('p.id')
    .select('p.id', 'p.nickname', 'p.age', 'p.nationality', 'p.team', 'c.payload'))
    .map(r => ({ id: Number(r.id), nickname: r.nickname, age: r.age == null ? null : Number(r.age),
      nationality: r.nationality, team: r.team, career: careerSchema.parse(JSON.parse(r.payload)) }));
}
export async function buildCandidate() {
  const snapshot = await transaction(async (trx) => {
    await lockRow(trx, "card_catalog", { id: 1 });
    const catalog = await trx("card_catalog").where({ id: 1 }).first();
    const rows = await sourceRows(trx);
    return { revision: Number(catalog.revision), rows };
  });
  const began = performance.now();
  const data = buildGraph(snapshot.rows);
  observe('graph_build_ms', performance.now() - began);
  observe('graph_nodes', data.players.length); observe('graph_edges', data.edges.length);
  if (Object.values(data.pairs).some((pairs) => pairs.length < 3))
    throw new HttpError(409, "CARD_POOL_UNAVAILABLE");
  await db("card_graphs")
    .insert({
      version: data.version,
      source_revision: snapshot.revision,
      source_hash: fingerprint(snapshot.rows),
      payload: JSON.stringify(data),
      created_at: Date.now(),
    })
    .onConflict("version")
    // Revalidation can reuse identical immutable graph content after a source-only edit.
    .merge({ source_revision: snapshot.revision, source_hash: fingerprint(snapshot.rows) });
  return {
    version: data.version,
    revision: snapshot.revision,
    buildMs: performance.now() - began,
    players: data.players.length,
    edges: data.edges.length,
    pairs: Object.fromEntries(
      Object.entries(data.pairs).map(([k, v]) => [k, v.length]),
    ),
  };
}
export async function publishGraph(version: string, actor: number | null = null) {
  return transaction(async (trx) => {
    const c = await lockRow(trx, "card_catalog", { id: 1 }),
      g = await trx("card_graphs").where({ version }).first();
    if (!g || Number(g.source_revision) !== Number(c.revision))
      throw new HttpError(409, "CARD_GRAPH_STALE");
    if (!g.source_hash || g.source_hash !== fingerprint(await sourceRows(trx)))
      throw new HttpError(409, 'CARD_GRAPH_STALE');
    const data: GraphData = JSON.parse(g.payload);
    if (Object.values(data.pairs).some((pairs) => pairs.length < 3))
      throw new HttpError(409, "CARD_POOL_UNAVAILABLE");
    await trx("card_catalog")
      .where({ id: 1 })
      .update({ graph_version: version, enabled: true });
    if (!g.published_at) await trx('card_graphs').where({ version }).update({ published_at: Date.now() });
    await auditOperation(trx, 'publish', actor, { before: c.graph_version, version });
    return { version };
  });
}

export async function rollbackGraph(version: string, expectedVersion: string, reason: string, actor: number) {
  return transaction(async trx => {
    const c = await lockRow(trx, 'card_catalog', { id: 1 });
    if (c.graph_version !== expectedVersion) throw new HttpError(409, 'CARD_VERSION_CONFLICT');
    const row = await trx('card_graphs').where({ version }).first();
    if (!row?.published_at) throw new HttpError(409, 'CARD_GRAPH_NOT_PUBLISHED');
    let data: GraphData;
    try {
      data = JSON.parse(row.payload);
      if (data.version !== version || fingerprint({ ...data, version: '' }) !== version ||
          !data.players.length || ['easy', 'normal', 'hard'].some(k => data.pairs[k as Difficulty]?.length < 3)) throw Error();
    } catch { throw new HttpError(409, 'CARD_GRAPH_INVALID'); }
    // Rollback changes only the pointer. A disabled game must stay disabled;
    // sources, current daily questions and historical versions remain intact.
    await trx('card_catalog').where({ id: 1 }).update({ graph_version: version });
    await auditOperation(trx, 'rollback', actor, { before: expectedVersion, version, reason });
    return { version };
  });
}
