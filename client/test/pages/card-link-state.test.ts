import { describe, it, expect } from "vitest";
import { acceptPatch, acceptState } from "../../src/card-link/state";
import type { View } from "../../src/card-link/types";
const view = {
  id: "game",
  phaseRevision: 2,
  revision: 5,
  players: [],
  current: { board: [1] },
} as unknown as View;
describe("card link synchronization", () => {
  it('synchronizes renewed expiry to other tabs and rejects older renewals', () => {
    const patch = { id: 'game', phaseRevision: 2, baseRevision: 5, revision: 6, players: [], dueAt: 10000, expiresAt: 10000 };
    const result = acceptPatch(view, patch).view!;
    expect(result.dueAt).toBe(10000); expect(result.expiresAt).toBe(10000);
    expect(acceptPatch(result, { ...patch, revision: 5, dueAt: 8000, expiresAt: 8000 }).view).toBe(result);
  });
  it("updates private evidence with the board and preserves it on public-only patches",()=>{
    const connections=[{a:1,b:2,evidence:[]}];
    const result=acceptPatch(view,{id:"game",phaseRevision:2,baseRevision:5,revision:6,players:[],current:view.current,connections});
    expect(result.view?.connections).toEqual(connections);
    const publicOnly=acceptPatch(result.view!,{id:"game",phaseRevision:2,baseRevision:6,revision:6,players:[]});
    expect(publicOnly.view?.connections).toEqual(connections);
    const legacy=acceptPatch(result.view!,{id:"game",phaseRevision:2,baseRevision:6,revision:7,players:[],current:view.current});
    expect(legacy.view?.connections).toEqual([]);
  });
  it("ignores stale snapshots and patches without regressing private state", () => {
    expect(acceptState(view, { ...view, revision: 4 })).toBe(view);
    expect(
      acceptPatch(view, {
        id: "game",
        phaseRevision: 1,
        baseRevision: 5,
        revision: 9,
        players: [],
      }),
    ).toEqual({ view, reload: false });
  });
  it("recovers a missing phase or private revision with a full load", () => {
    expect(
      acceptPatch(view, {
        id: "game",
        phaseRevision: 2,
        baseRevision: 6,
        revision: 7,
        players: [],
      }).reload,
    ).toBe(true);
    expect(
      acceptPatch(view, {
        id: "game",
        phaseRevision: 3,
        baseRevision: 5,
        revision: 6,
        players: [],
      }).reload,
    ).toBe(true);
  });
  it("keeps the hand on public-only updates", () => {
    const result = acceptPatch(view, {
      id: "game",
      phaseRevision: 2,
      baseRevision: 5,
      revision: 5,
      players: [],
    });
    expect(result.reload).toBe(false);
    expect(result.view?.current).toBe(view.current);
  });
  it("accepts a new round even with a lower player revision", () => {
    const next = { ...view, phaseRevision: 3, revision: 0, current: null };
    expect(acceptState(view, next)).toBe(next);
  });
});
