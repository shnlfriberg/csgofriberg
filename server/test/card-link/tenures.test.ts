import { describe, it, expect } from "vitest";
import { effectiveTenures } from "../../src/card-link/tenures";
import { careerSchema, type Career } from "../../src/card-link/careers";
import { buildGraph } from "../../src/card-link/graphs";
type Tenure = Career["tenures"][number];
const tenure = (
  teamId: string,
  start: string,
  end: string,
  status: Tenure["status"] = "active",
): Tenure => ({
  teamId,
  team: teamId,
  start,
  end,
  status,
  game: "csgo",
  precision: "day",
  rawDates: `${start} — ${end}`,
  source: "https://example.com/P",
  verified: false,
});
describe("certain active careers", () => {
  it("never counts staff employment, but preserves an independently recorded playing tenure", () => {
    const staff = { ...tenure("A", "2020-03-01", "2021-01-01", "staff"), verified: true };
    const result = effectiveTenures([tenure("A", "2020-01-01", "2021-01-01"), staff,
      tenure("B", "2020-01-01", "2021-01-01", "inactive")]);
    expect(result.map(t => [t.teamId, t.start, t.end])).toEqual([["A", "2020-01-01", "2021-01-01"]]);
    expect(effectiveTenures([staff])).toEqual([]);
  });
  it("retains supplemental date sources on graph evidence and excludes reversed exact dates", () => {
    const t = tenure("A", "2020-01-01", "2021-01-01");
    const career = (tenures: Tenure[], personKey: string): Career => ({personKey,page:t.source,sourceRevision:"1",observedAt:"2026-10-24",aliases:[],locked:false,tenures});
    const corrected = {...t, manual:{fields:["start" as const],source:"https://www.hltv.org/player/1/a",checkedAt:"2026-10-24",note:"Evidence"}};
    const graph = buildGraph([
      {id:1,nickname:"A",nationality:"",team:"",career:career([corrected],"a")},
      {id:2,nickname:"B",nationality:"",team:"",career:career([t],"b")},
      {id:3,nickname:"C",nationality:"",team:"",career:career([{...t,start:"2022-01-01"}],"c")},
    ]);
    expect(graph.edges).toHaveLength(1);
    expect(graph.edges[0].evidence[0].sources).toContain(corrected.manual.source);
  });
  it("subtracts a loan from the parent roster but keeps actual loan teammates", () => {
    const result = effectiveTenures([
      tenure("A", "2020-01-01", "2021-01-01"),
      tenure("B", "2020-03-01", "2020-06-01", "loan"),
    ]);
    expect(result.map((t) => [t.teamId, t.start, t.end])).toEqual([
      ["A", "2020-01-01", "2020-03-01"],
      ["A", "2020-06-01", "2021-01-01"],
      ["B", "2020-03-01", "2020-06-01"],
    ]);
  });
  it("excludes ambiguous simultaneous active employments on both sides", () => {
    const result = effectiveTenures([
      tenure("A", "2020-01-01", "2020-06-01"),
      tenure("B", "2020-03-01", "2021-01-01"),
    ]);
    expect(result.map((t) => [t.teamId, t.start, t.end])).toEqual([
      ["A", "2020-01-01", "2020-03-01"],
      ["B", "2020-06-01", "2021-01-01"],
    ]);
  });
  it("subtracts inactive time and never counts unverified stand-ins", () => {
    const result = effectiveTenures([
      tenure("A", "2020-01-01", "2021-01-01"),
      tenure("A", "2020-03-01", "2021-01-01", "inactive"),
      tenure("C", "2020-02-01", "2020-02-03", "standin"),
    ]);
    expect(result).toHaveLength(1);
    expect(result[0].end).toBe("2020-03-01");
  });
  it("rejects executable source URLs", () => {
    const career = {
      personKey: "p",
      page: "javascript:alert(1)",
      sourceRevision: "x",
      observedAt: "2026-10-24",
      aliases: [],
      tenures: [],
    };
    expect(careerSchema.safeParse(career).success).toBe(false);
  });
});
