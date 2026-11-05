import { describe, it, expect } from "vitest";
import {
  applyCommand,
  createRound,
  graphIndex,
  shortestPath,
  recoveryPath,
  recoverRound,
  compareResults,
  publicRound,
  stopRound,
  type GraphData,
  type Question,
} from "@friberg/card-link-core";
const data: GraphData = {
  version: "fixture",
  players: Array.from({ length: 15 }, (_, i) => ({
    id: i + 1,
    nickname: `p${i + 1}`,
    team: "",
    nationality: "",
    aliases: [],
  })),
  edges: [
    [1, 2],
    [2, 3],
    [3, 4],
    [1, 5],
    [5, 6],
    [6, 7],
    [7, 4],
    [2, 8],
    [8, 9],
    [9, 4],
    [1, 10],
    [10, 11],
    [11, 12],
    [12, 4],
  ].map(([a, b]) => ({ a, b, evidence: [] })),
  pairs: { easy: [], normal: [[1, 4]], hard: [] },
};
const graph = graphIndex(data),
  q: Question = {
    graphVersion: "fixture",
    start: 1,
    end: 4,
    pool: data.players.map((p) => p.id).filter((id) => id !== 1 && id !== 4),
  };
describe("card link pure engine", () => {
  it('earns credits for plays and board discards, caps at two, and spends only one per swap or refresh', () => {
    let s = createRound(graph, q, 'limited', 1, 0, null);
    s.board = [5, 6, 7]; s.hand = [2, 3, 13, 14, 15]; s.deck = [8, 9, 10, 11, 12];
    const command = (input: Parameters<typeof applyCommand>[4]) => {
      s = applyCommand(graph, q, 'limited', s, input, 100);
    };
    command({ type: 'remove', playerId: 6 }); expect(s.token).toBe(1);
    command({ type: 'remove', playerId: 5 }); expect(s.token).toBe(2);
    command({ type: 'remove', playerId: 7 }); expect(s.token).toBe(2);
    expect(s.discarded).toEqual([6, 5, 7]);
    command({ type: 'play', playerId: 2, index: 0 }); expect(s.token).toBe(2);
    command({ type: 'play', playerId: 3, index: 1 }); expect(s.token).toBe(2);
    command({ type: 'swap', playerId: 13 }); expect(s.token).toBe(1);
    command({ type: 'refresh' }); expect(s.token).toBe(0);
    expect(() => command({ type: 'refresh' })).toThrow('CARD_NO_TOKEN');
    expect(() => command({ type: 'remove', playerId: 6 })).toThrow('CARD_INVALID_CARD');
    expect(s.token).toBe(0);
  });
  it('accumulates two consecutive plays and leaves credits unchanged during automatic rescue', () => {
    let s = createRound(graph, q, 'limited', 1, 0, null);
    s.board = []; s.hand = [2, 3, 13, 14, 15]; s.deck = [5, 6, 7, 8, 9, 10, 11, 12];
    s = applyCommand(graph, q, 'limited', s, { type: 'play', playerId: 2, index: 0 }, 1);
    expect(s.token).toBe(1);
    s = applyCommand(graph, q, 'limited', s, { type: 'play', playerId: 3, index: 1 }, 2);
    expect(s.token).toBe(2);
    const blocked = createRound(graph, q, 'limited', 1, 0, null);
    blocked.hand = [13, 14, 15]; blocked.deck = q.pool.filter(id => !blocked.hand.includes(id)); blocked.token = 2;
    const repaired = recoverRound(graph, q, blocked, 3)!;
    expect(repaired.token).toBe(2); expect(repaired.refreshes).toBe(1);
  });
  it.each(['limited', 'unlimited'] as const)('keeps distant links and the saved best after middle removal (%s)', variant => {
    const s = createRound(graph, q, variant, 1, 0, null);
    s.board = [5, 6, 7]; s.hand = [2, 3]; s.deck = [];
    s.best = { path: [1, 5, 6, 7, 4], elapsed: 100 };
    const result = applyCommand(graph, q, variant, s, { type: 'remove', playerId: 6 }, 200);
    expect(result.board).toEqual([5, 7]);
    expect(publicRound(graph, q, result).links).toEqual([true, false, true]);
    expect(result.best).toEqual(s.best);
    expect(result.locked).toBe(false);
    expect(s.board).toEqual([5, 6, 7]);
  });
  it('persists a stable stop time without altering score time, and caps delayed expiry at the deadline', () => {
    const original = createRound(graph, q, 'unlimited', 1, 1000, null);
    original.best = { path: [1, 2, 3, 4], elapsed: 1500 };
    const locked = applyCommand(graph, q, 'unlimited', original, { type: 'lock' }, 5000);
    expect(locked.stoppedAt).toBe(5000); expect(locked.best!.elapsed).toBe(1500);
    stopRound(locked, 9000); expect(locked.stoppedAt).toBe(5000);
    expect(publicRound(graph, q, locked).stoppedAt).toBe(5000);
    expect(original.stoppedAt).toBeUndefined();
    const timed = createRound(graph, q, 'unlimited', 1, 1000, 5);
    stopRound(timed, 10000); expect(timed.stoppedAt).toBe(6000);
  });
  it('rescues an unsolvable hand on a rejected insertion exactly once without spending credit', () => {
    const s = createRound(graph, q, 'limited', 1, 0, null);
    s.hand = [13, 14, 15]; s.board = []; s.token = 0;
    s.deck = q.pool.filter(id => !s.hand.includes(id)); s.discarded = [];
    const before = structuredClone(s);
    const fixed = applyCommand(graph, q, 'limited', s, { type: 'play', playerId: 13, index: 0 }, 1);
    expect(fixed.refreshes).toBe(1); expect(fixed.token).toBe(0);
    expect(fixed.board).toEqual([]); expect(fixed.discarded).toEqual(before.hand);
    expect(fixed.locked).toBe(false);
    expect(shortestPath(graph, q.start, q.end, new Set([q.start, q.end, ...fixed.hand]))).not.toBeNull();
    expect(new Set([...fixed.hand, ...fixed.deck, ...fixed.discarded]).size).toBe(q.pool.length);
    expect(fixed.hand.some(id => before.hand.includes(id))).toBe(false);
    expect(recoverRound(graph, q, fixed)).toBeNull();
    expect(s).toEqual(before);
    expect(applyCommand(graph, q, 'limited', s, { type: 'refresh' }, 1)).toEqual(fixed);
  });
  it('does not grant a free refresh for an invalid insertion when rearranging available cards can solve it', () => {
    const s = createRound(graph, q, 'limited', 1, 0, null);
    s.board = [3, 2]; s.hand = [13, 14, 15];
    s.deck = q.pool.filter(id => ![...s.board, ...s.hand].includes(id));
    const before = structuredClone(s);
    expect(recoverRound(graph, q, s)).toBeNull();
    expect(() => applyCommand(graph, q, 'limited', s, { type: 'play', playerId: 13, index: 1 }, 1)).toThrow('CARD_NO_CONNECTION');
    expect(s).toEqual(before);
  });
  it('ends an unrecoverable blocked hand while keeping its best score and discarded cards', () => {
    const s = createRound(graph, q, 'limited', 1, 0, null);
    s.board = []; s.hand = [13, 14, 15]; s.deck = []; s.discarded = q.pool.filter(id => !s.hand.includes(id));
    s.best = { path: [1, 2, 3, 4], elapsed: 500 };
    const fixed = recoverRound(graph, q, s)!;
    expect(fixed).toMatchObject({ locked: true, exhausted: true, best: s.best, refreshes: 0, discarded: s.discarded });
    expect(recoverRound(graph, q, fixed)).toBeNull();
  });
  it("uses linear search and minimizes new cards independently of hop count", () => {
    expect(shortestPath(graph, 1, 4)).toEqual([1, 2, 3, 4]);
    expect(
      recoveryPath(graph, 1, 4, new Set([1, 4, 5, 6, 7]), new Set([2, 3])),
    ).toEqual([1, 5, 6, 7, 4]);
  });
  it("returns null for disconnected and forbidden routes", () => {
    expect(shortestPath(graph, 1, 15)).toBeNull();
    expect(recoveryPath(graph, 1, 4, new Set([1, 4]), new Set())).toBeNull();
  });
  it("deals solvable reproducible distinct hands across 300 seeds", () => {
    let variations = new Set<string>();
    for (let seed = 1; seed <= 300; seed++) {
      const s = createRound(graph, q, "limited", seed, 100, 180);
      expect(s).toEqual(createRound(graph, q, "limited", seed, 100, 180));
      expect(s.hand).toHaveLength(7);
      expect(
        shortestPath(graph, 1, 4, new Set([1, 4, ...s.hand])),
      ).not.toBeNull();
      expect(new Set([...s.hand, ...s.deck]).size).toBe(q.pool.length);
      variations.add(s.hand.join(","));
    }
    expect(variations.size).toBeGreaterThan(10);
  });
  it("refills and caps credit, while shuffle does not mint resources", () => {
    let s = createRound(graph, q, "limited", 10, 0, null);
    const path = shortestPath(graph, 1, 4, new Set([1, 4, ...s.hand]))!;
    s = applyCommand(
      graph,
      q,
      "limited",
      s,
      { type: "play", playerId: path[1], index: 0 },
      100,
    );
    expect(s.token).toBe(1);
    expect(s.hand).toHaveLength(7);
    const before = structuredClone(s);
    s = applyCommand(
      graph,
      q,
      "limited",
      s,
      { type: "reorder", board: s.board },
      150,
    );
    expect(s.deck).toEqual(before.deck);
    expect(s.token).toBe(1);
  });
  it("rejects illegal play atomically and does not mutate input", () => {
    const s = createRound(graph, q, "limited", 10, 0, null),
      before = structuredClone(s);
    expect(() =>
      applyCommand(
        graph,
        q,
        "limited",
        s,
        { type: "play", playerId: 15, index: 0 },
        1,
      ),
    ).toThrow();
    expect(s).toEqual(before);
    expect(() =>
      applyCommand(graph, q, "limited", s, { type: "refresh" }, 1),
    ).toThrow("CARD_NO_TOKEN");
  });
  it("retains the earliest best chain and ranks length before speed", () => {
    let s = createRound(graph, q, "unlimited", 1, 0, null);
    for (const [i, id] of [5, 6, 7].entries())
      s = applyCommand(
        graph,
        q,
        "unlimited",
        s,
        { type: "play", playerId: id, index: i },
        100 + i,
      );
    expect(s.best!.path).toEqual([1, 5, 6, 7, 4]);
    for (const id of [5, 6, 7])
      s = applyCommand(
        graph,
        q,
        "unlimited",
        s,
        { type: "remove", playerId: id },
        200,
      );
    expect(s.best!.path.length).toBe(5);
    s = applyCommand(
      graph,
      q,
      "unlimited",
      s,
      { type: "play", playerId: 2, index: 0 },
      1000,
    );
    s = applyCommand(
      graph,
      q,
      "unlimited",
      s,
      { type: "play", playerId: 3, index: 1 },
      2000,
    );
    expect(s.best!.elapsed).toBe(2000);
    expect(
      compareResults([s.best], [{ path: [1, 5, 6, 7, 4], elapsed: 1 }]),
    ).toBeLessThan(0);
  });
  it("locks at deadline and never exposes deck or random state", () => {
    const s = createRound(graph, q, "limited", 1, 0, 180);
    expect(() =>
      applyCommand(graph, q, "limited", s, { type: "lock" }, 180000),
    ).toThrow("CARD_TIME_EXPIRED");
    const v = publicRound(graph, q, s);
    expect(v).not.toHaveProperty("rng");
    expect(v).not.toHaveProperty("deck");
  });
  it("discards permanently and restores using a proven route", () => {
    let s = createRound(graph, q, "limited", 1, 0, null);
    s.hand = [2, 3, 13, 14, 15];
    s.deck = [5, 6, 7, 8, 9, 10, 11, 12];
    s = applyCommand(
      graph,
      q,
      "limited",
      s,
      { type: "play", playerId: 2, index: 0 },
      1,
    );
    s = applyCommand(
      graph,
      q,
      "limited",
      s,
      { type: "remove", playerId: 2 },
      2,
    );
    expect(s.discarded).toContain(2);
    expect([...s.hand, ...s.deck, ...s.board]).not.toContain(2);
    if (!s.exhausted)
      expect(
        shortestPath(graph, 1, 4, new Set([1, 4, ...s.hand, ...s.board])),
      ).not.toBeNull();
  });
  it("cannot revive a discarded articulation point", () => {
    const line = graphIndex({
      ...data,
      edges: [
        [1, 2],
        [2, 4],
      ].map(([a, b]) => ({ a, b, evidence: [] })),
    });
    let s = createRound(line, q, "limited", 1, 0, null);
    s = applyCommand(
      line,
      q,
      "limited",
      s,
      { type: "play", playerId: 2, index: 0 },
      1,
    );
    s = applyCommand(line, q, "limited", s, { type: "remove", playerId: 2 }, 2);
    expect(s.exhausted).toBe(true);
    expect(s.locked).toBe(true);
    expect(s.best?.path).toEqual([1, 2, 4]);
  });
  it("rejects duplicate endpoints, duplicated cards and malformed reorder", () => {
    const s = createRound(graph, q, "unlimited", 1, 0, null);
    expect(() =>
      applyCommand(
        graph,
        q,
        "unlimited",
        s,
        { type: "play", playerId: 1, index: 0 },
        1,
      ),
    ).toThrow();
    expect(() =>
      applyCommand(
        graph,
        q,
        "unlimited",
        s,
        { type: "reorder", board: [2] },
        1,
      ),
    ).toThrow();
  });
});
