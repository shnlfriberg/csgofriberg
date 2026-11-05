import { describe, expect, it } from "vitest";
import type { Career } from "../../src/card-link/careers";
import { playerTimelineAt, teamsAt, timelineDate, type TimelinePlayer } from "../../src/card-link/timeline";

export const tenure = (teamId: string, start = "2020-01-01", end = "2021-01-01",
  status: Career["tenures"][number]["status"] = "active"): Career["tenures"][number] => ({
  teamId, team: teamId, start, end, status, precision: "day", game: "csgo",
  source: "https://example.com/player", rawDates: `${start} — ${end}`, verified: false,
});
export const career = (personKey: string, tenures: Career["tenures"]): Career => ({
  personKey, tenures, page: "https://example.com/player", sourceRevision: "1",
  observedAt: "2020-12-31", aliases: [], locked: false,
});
const player = (playerId: number, tenures: Career["tenures"], personKey = String(playerId)): TimelinePlayer => ({
  playerId, nickname: `P${playerId}`, career: career(personKey, tenures),
});
const members = (rows: TimelinePlayer[], at: string) =>
  playerTimelineAt(rows, 1, at)!.teams.flatMap(t => t.teammates.map(p => p.playerId));

describe("point-in-time career facts", () => {
  it("uses half-open transfer boundaries, gaps and repeated returns", () => {
    const t = [tenure("A", "2020-01-01", "2020-03-01"),
      tenure("B", "2020-03-01", "2020-06-01"), tenure("A", "2020-07-01")];
    expect(teamsAt(t, "2019-12-31")).toEqual([]);
    expect(teamsAt(t, "2020-01-01").map(t => t.teamId)).toEqual(["A"]);
    expect(teamsAt(t, "2020-03-01").map(t => t.teamId)).toEqual(["B"]);
    expect(teamsAt(t, "2020-06-01")).toEqual([]);
    expect(teamsAt(t, "2020-07-01").map(t => t.teamId)).toEqual(["A"]);
    expect(teamsAt(t, "2021-01-01")).toEqual([]);
  });
  it("normalizes explicit timezone instants and rejects invalid or local times", () => {
    expect(timelineDate("2020-03-01T01:00:00+08:00")).toBe("2020-02-29");
    expect(timelineDate("2020-03-01T00:00:00Z")).toBe("2020-03-01");
    for (const date of ["2020-02-30", "2019-02-29", "2020-03-01T00:00:00", "2020", ""]) {
      expect(() => timelineDate(date)).toThrow();
    }
  });
  it("does not infer unknown dates, widen coarse bounds, or extend Present", () => {
    const t = [{ ...tenure("A"), start: null, precision: "unknown" as const },
      { ...tenure("B", "2020-01-31", "2020-03-01"), precision: "month" as const },
      { ...tenure("C", "2020-05-01", "2020-05-11"), rawDates: "2020-05-01 — Present" },
      tenure("D", "2021-01-01", "2020-01-01")];
    expect(teamsAt(t, "2020-01-15")).toEqual([]);
    expect(teamsAt(t, "2020-02-01")[0].evidence[0].precision).toBe("month");
    expect(teamsAt(t, "2020-05-10")[0].teamId).toBe("C");
    expect(teamsAt(t, "2020-05-11")).toEqual([]);
  });
  it("finds simultaneous teammates, not different eras or same-name academies", () => {
    const rows = [player(1, [tenure("A")]), player(2, [tenure("A")]),
      player(3, [tenure("A", "2021-01-01", "2022-01-01")]),
      player(4, [{ ...tenure("A-academy"), team: "A" }])];
    expect(members(rows, "2020-06-01")).toEqual([2]);
    expect(members(rows, "2021-01-01")).toEqual([]);
  });
  it("applies loan and inactive rules on both players before matching", () => {
    const rows = [player(1, [tenure("A"), tenure("B", "2020-03-01", "2020-06-01", "loan")]),
      player(2, [tenure("A")]), player(3, [tenure("B")]),
      player(4, [tenure("B"), tenure("B", "2020-04-01", "2020-05-01", "inactive")])];
    expect(members(rows, "2020-02-01")).toEqual([2]);
    expect(members(rows, "2020-03-01")).toEqual([3, 4]);
    expect(members(rows, "2020-04-01")).toEqual([3]);
    expect(members(rows, "2020-06-01")).toEqual([2]);
  });
  it("excludes conflicting employments and staff; verifies temporary players", () => {
    const rows = [player(1, [tenure("A")]),
      player(2, [tenure("A"), tenure("B")]), player(3, [tenure("A", undefined, undefined, "staff")]),
      player(4, [tenure("A", undefined, undefined, "standin")]),
      player(5, [{ ...tenure("A", undefined, undefined, "trial"), verified: true }]),
      player(6, [tenure("A"), tenure("A", undefined, undefined, "staff")])];
    expect(members(rows, "2020-02-01")).toEqual([5, 6]);
  });
  it("merges duplicate identities before conflict checks and never returns self", () => {
    const rows = [player(1, [tenure("A")], "self"), player(9, [tenure("A")], "self"),
      player(2, [tenure("A")], "peer"), player(3, [tenure("A")], "peer"),
      player(4, [tenure("A")], "conflict"), player(5, [tenure("B")], "conflict")];
    const before = JSON.stringify(rows);
    const result = playerTimelineAt(rows, 1, "2020-02-01")!;
    expect(result.teams[0].teammates).toMatchObject([{ playerId: 2, playerIds: [2, 3] }]);
    expect(result.teams[0].teammates).toHaveLength(1);
    expect(JSON.stringify(rows)).toBe(before);
  });
  it("distinguishes unknown players, missing careers, and unconfirmed membership", () => {
    expect(playerTimelineAt([], 1, "2020-01-01")).toBeNull();
    expect(playerTimelineAt([{ playerId: 1, nickname: "legacy", career: null }], 1, "2020-01-01"))
      .toMatchObject({ coverage: "missing-career", teams: [] });
    expect(playerTimelineAt([player(1, [])], 1, "2020-01-01"))
      .toMatchObject({ coverage: "no-confirmed-team", teams: [] });
  });
});
