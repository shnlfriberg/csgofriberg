import { describe, it, expect, vi } from "vitest";
import { randomInt } from "crypto";
vi.mock("crypto", async importOriginal => ({ ...await importOriginal<typeof import("crypto")>(), randomInt: vi.fn((await importOriginal<typeof import("crypto")>()).randomInt) }));
import {
  graphIndex,
  createRound,
  shortestPath,
  applyCommand,
  links,
  type GraphData,
  type Command,
} from "@friberg/card-link-core";
import { selectQuestions } from "../../src/card-link/graphs";

const data: GraphData = {
  version: "fixture",
  players: Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    nickname: `P${i}`,
    nationality: "",
    team: "",
    aliases: [],
  })),
  edges: Array.from({ length: 18 }, (_, i) => ({
    a: i + 1,
    b: i + 2,
    evidence: [],
  })),
  pairs: {
    easy: [
      [1, 3],
      [2, 4],
      [3, 5],
    ],
    normal: [
      [1, 4],
      [2, 5],
      [3, 6],
    ],
    hard: [
      [1, 6],
      [2, 7],
      [3, 8],
    ],
  },
};
const index = graphIndex(data);
describe("question quality and resource invariants", () => {
  it("searches beyond an invalid prefix and treats reversed endpoint pairs as duplicates", async () => {
    const mock = vi.mocked(randomInt).mockImplementation(((min: number, max?: number) => max === undefined ? 0 : min) as typeof randomInt);
    try {
      const corrupted = { ...data, pairs: { ...data.pairs, normal: [...Array.from({ length: 300 }, () => [1, 20] as [number, number]), [1, 4] as [number, number], [4, 1] as [number, number], [2, 5] as [number, number], [3, 6] as [number, number]] } };
      const selected = selectQuestions({data: corrupted, index}, "normal", 3);
      expect(new Set(selected.map(q => [q.start,q.end].sort((a,b)=>a-b).join(":"))).size).toBe(3);
    } finally { mock.mockImplementation((await vi.importActual<typeof import("crypto")>("crypto")).randomInt); }
  });
  it("prefers different endpoint players when the candidate pool allows it", async () => {
    const mock = vi.mocked(randomInt).mockImplementation(((min: number, max?: number) => max === undefined ? 0 : min) as typeof randomInt);
    try {
      const pool = { ...data, pairs: { ...data.pairs, normal: [[1,4], [4,7], [2,5], [3,6]] as [number,number][] } };
      const selected = selectQuestions({ data: pool, index }, "normal", 3);
      expect(new Set(selected.flatMap(q => [q.start,q.end])).size).toBe(6);
    } finally { mock.mockImplementation((await vi.importActual<typeof import("crypto")>("crypto")).randomInt); }
  });
  it("checks all difficulty bands and prevents repeated endpoints in a match", () => {
    for (const difficulty of ["easy", "normal", "hard"] as const)
      for (let i = 0; i < 50; i++) {
        const questions = selectQuestions({ data, index }, difficulty, 3);
        expect(
          new Set(
            questions.map((q) =>
              [q.start, q.end].sort((a, b) => a - b).join(":"),
            ),
          ).size,
        ).toBe(3);
        for (const q of questions) {
          expect(q.pool).not.toContain(20);
          const path = shortestPath(
            index,
            q.start,
            q.end,
            new Set([q.start, q.end, ...q.pool]),
          )!;
          expect(path.length - 1).toBe(
            difficulty === "easy" ? 2 : difficulty === "normal" ? 3 : 5,
          );
          for (let seed = 1; seed < 10; seed++) {
            const s = createRound(index, q, "limited", seed, 0, null);
            expect(
              shortestPath(
                index,
                q.start,
                q.end,
                new Set([q.start, q.end, ...s.hand]),
              ),
            ).not.toBeNull();
          }
        }
      }
  });
  it("rejects corrupt endpoint candidates and disconnected pools before dealing", () => {
    expect(() =>
      selectQuestions(
        {
          data: {
            ...data,
            pairs: {
              ...data.pairs,
              normal: [
                [1, 20],
                [1, 2],
                [1, 1],
              ],
            },
          },
          index,
        },
        "normal",
        1,
      ),
    ).toThrow("CARD_POOL_UNAVAILABLE");
    for (const variant of ["limited", "unlimited"] as const)
      expect(() =>
        createRound(
          index,
          { graphVersion: "fixture", start: 1, end: 4, pool: [5, 6] },
          variant,
          1,
          0,
          null,
        ),
      ).toThrow("CARD_POOL_UNAVAILABLE");
  });
  it("preserves ownership and solvability through deterministic mixed actions", () => {
    const graph = graphIndex({
      ...data,
      edges: [
        ...data.edges,
        ...Array.from({ length: 15 }, (_, i) => ({
          a: i + 1,
          b: i + 4,
          evidence: [],
        })),
      ],
    });
    const q = {
      graphVersion: "fixture",
      start: 1,
      end: 12,
      pool: data.players.map((p) => p.id).filter((id) => id !== 1 && id !== 12),
    };
    for (let seed = 1; seed <= 200; seed++) {
      let state = createRound(graph, q, "limited", seed, 0, null),
        rng = seed;
      for (let step = 1; step <= 60 && !state.locked; step++) {
        rng = (Math.imul(rng, 1664525) + 1013904223) >>> 0;
        let command: Command;
        if (rng % 5 === 0 && state.board.length)
          command = {
            type: "remove",
            playerId: state.board[rng % state.board.length],
          };
        else if (rng % 5 === 1 && state.token) command = { type: "refresh" };
        else if (rng % 5 === 2)
          command = { type: "reorder", board: [...state.board].reverse() };
        else
          command = {
            type: "play",
            playerId: state.hand[rng % state.hand.length],
            index: state.board.length,
          };
        const before = structuredClone(state);
        try {
          state = applyCommand(graph, q, "limited", state, command, step);
        } catch {
          expect(state).toEqual(before);
        }
        const cards = [
          ...state.hand,
          ...state.board,
          ...state.deck,
          ...state.discarded,
        ];
        expect(cards.length).toBe(q.pool.length);
        expect(new Set(cards).size).toBe(cards.length);
        expect([0, 1, 2]).toContain(state.token);
        expect(
          before.discarded.every((id) => state.discarded.includes(id)),
        ).toBe(true);
        if (!state.exhausted)
          expect(
            shortestPath(
              graph,
              q.start,
              q.end,
              new Set([q.start, q.end, ...state.hand, ...state.board]),
            ),
          ).not.toBeNull();
        if (state.best)
          expect(links(graph, state.best.path).every(Boolean)).toBe(true);
      }
    }
  });
});
