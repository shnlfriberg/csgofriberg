import { createHash } from "crypto";
import {
  publicRound,
  shortestPath,
  type GraphData,
  type Graph,
} from "@friberg/card-link-core";
import type { Match, Seat, SeatRow } from "./types";
const evidenceIndexes = new WeakMap<GraphData, Map<string, GraphData["edges"][number]>>();
const edgeKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
function evidenceIndex(data: GraphData) {
  let indexed = evidenceIndexes.get(data);
  if (!indexed) {
    indexed = new Map(data.edges.map(edge => [edgeKey(edge.a, edge.b), edge]));
    evidenceIndexes.set(data, indexed);
  }
  return indexed;
}
const seatIds = new Map<string, string>();
/** Public seat id (memoized: it is hashed for every seat in every view). */
export const seatId = (key: string) => {
  let id = seatIds.get(key);
  if (!id) {
    id = createHash("sha256").update(`card-display:${key}`).digest("hex").slice(0, 16);
    seatIds.set(key, id);
    if (seatIds.size > 20_000) seatIds.delete(seatIds.keys().next().value!);
  }
  return id;
};
type GraphPair = { data: GraphData; index: Graph };
/**
 * Parts of a match view that are identical for every seat. Computed once per
 * notification instead of once per recipient (solution search, evidence,
 * player summaries and seat id hashes).
 */
export function publicMatchView(m: Match, rows: SeatRow[], graph: GraphPair) {
  const seats = rows.map((r) => JSON.parse(r.payload) as Seat);
  const q = m.questions[m.round];
  const revealed = ["roundOver", "finished"].includes(m.status);
  const solution = revealed
    ? shortestPath(graph.index, q.start, q.end, new Set([q.start, q.end, ...q.pool]))
    : null;
  const indexed = evidenceIndex(graph.data);
  const needed = new Set<string>();
  for (let i = 1; i < (solution?.length ?? 0); i++)
    needed.add(edgeKey(solution![i - 1], solution![i]));
  if (revealed)
    for (const seat of seats) {
      const path = seat.results[m.round]?.path ?? [];
      for (let i = 1; i < path.length; i++)
        needed.add(
          `${Math.min(path[i - 1], path[i])}:${Math.max(path[i - 1], path[i])}`,
        );
    }
  return {
    seats,
    question: q,
    publicRevision: rows.reduce((sum, r) => sum + Number(r.revision), 0),
    players: seats.map((p) => ({
      id: seatId(p.owner.key),
      name: p.owner.name,
      ready: p.ready,
      retired: p.retired,
      connected: p.connected ?? true,
      disconnectAt: p.disconnectAt ?? null,
      solved: !!p.current?.best,
      locked: !!p.current?.locked,
      results: p.results,
    })),
    solution,
    evidence: revealed
      ? [...needed].flatMap(key => { const edge = indexed.get(key); return edge ? [edge] : []; })
      : [],
  };
}
export type PublicMatchView = ReturnType<typeof publicMatchView>;
/** The private view of one seat built on the shared public part. */
export function seatMatchView(
  m: Match,
  rows: SeatRow[],
  key: string,
  graph: GraphPair,
  shared: PublicMatchView,
) {
  const index = rows.findIndex((r) => r.identity_key === key);
  if (index < 0) throw new Error("CARD_VIEW_FORBIDDEN");
  const row = rows[index];
  const me = shared.seats[index],
    q = shared.question;
  const indexed = evidenceIndex(graph.data);
  const connections: GraphData["edges"] = [];
  if (me.current && m.status !== "waiting") {
    const chain = [q.start, ...me.current.board, q.end];
    for (let i = 1; i < chain.length; i++) {
      if (!graph.index.get(chain[i - 1])?.has(chain[i])) continue;
      const edge = indexed.get(edgeKey(chain[i - 1], chain[i]));
      if (edge) connections.push(edge);
    }
  }
  return {
    id: m.id,
    code: m.code,
    scene: m.scene,
    variant: m.variant,
    difficulty: m.difficulty,
    status: m.status,
    phaseRevision: m.revision,
    publicRevision: shared.publicRevision,
    revision: Number(row.revision),
    round: m.round,
    rounds: m.questions.length,
    duration: m.duration,
    dueAt: m.dueAt,
    expiresAt: m.expiresAt,
    day: m.day,
    dailyPractice: m.dailyPractice === true,
    rulesVersion: m.rulesVersion,
    graphVersion: m.questions[0].graphVersion,
    me: seatId(key),
    host: m.host === key,
    question: m.status === "waiting" ? null : { start: q.start, end: q.end },
    current: me.current ? publicRound(graph.index, q, me.current) : null,
    // Only the viewer's already-connected adjacent cards, never opponents' paths.
    connections,
    players: shared.players,
    solution: shared.solution,
    evidence: shared.evidence,
  };
}
export function matchView(
  m: Match,
  rows: SeatRow[],
  key: string,
  graph: GraphPair,
) {
  if (!rows.some((r) => r.identity_key === key)) throw new Error("CARD_VIEW_FORBIDDEN");
  return seatMatchView(m, rows, key, graph, publicMatchView(m, rows, graph));
}
export type MatchView = ReturnType<typeof matchView>;

/**
 * Compact command response (game protocol v2): only the sections one seat's
 * command can change, on top of `baseRevision` (the seat revision the command
 * was checked against). Same shape as the `card-link:patch` push, so clients
 * merge both the same way. Used only while the match phase is unchanged; a
 * phase change (round over, finished) still returns the full view.
 */
export function seatPatch(view: MatchView, baseRevision: number) {
  return {
    id: view.id,
    phaseRevision: view.phaseRevision,
    publicRevision: view.publicRevision,
    baseRevision,
    revision: view.revision,
    dueAt: view.dueAt,
    expiresAt: view.expiresAt,
    players: view.players,
    current: view.current,
    connections: view.connections,
  };
}
