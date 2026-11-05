import { describe, expect, it } from "vitest";
import { mergeCareer, sameCareerData } from "../../src/card-link/careerSync";
import { careerSchema, type Career } from "../../src/card-link/careers";
const make = (): Career => ({ personKey: "person:1", page: "https://example.com/player", sourceRevision: "r1", observedAt: "2026-10-24", aliases: [], locked: false, tenures: [{ teamId: "A", team: "A", game: "csgo", start: "2014-12-31", end: "2015-01-01", precision: "year", status: "active", rawDates: "2014 — 2015", source: "https://example.com/player", verified: false }] });
describe("incremental career source merging", () => {
  it("closes a previous team and appends the new roster while preserving manual dates and old history", () => {
    const original = make();
    original.tenures[0] = { ...original.tenures[0], start: "2020-01-01", end: "2026-10-25", precision: "day", rawDates: "2020-01-01 — Present" };
    const corrected = structuredClone(original); corrected.tenures[0].start = "2020-02-01";
    const old = mergeCareer(original, corrected, true).career;
    const fresh = structuredClone(original);
    fresh.tenures[0].end = "2026-10-20"; fresh.tenures[0].rawDates = "2020-01-01 — 2026-10-20";
    fresh.tenures.push({ ...fresh.tenures[0], teamId: "B", team: "B", start: "2026-10-21", end: "2026-10-25", rawDates: "2026-10-21 — Present" });
    const result = mergeCareer(old, fresh, false);
    expect(result.conflict).toBe(false);
    expect(result.career.tenures[0]).toMatchObject({ teamId: "A", start: "2020-02-01", end: "2026-10-20" });
    expect(result.career.tenures[1]).toMatchObject({ teamId: "B", start: "2026-10-21" });
    expect(sameCareerData(result.career, mergeCareer(result.career, fresh, false).career)).toBe(true);
  });
  it("ignores page revision and collection-date changes when career facts did not change", () => {
    const old = make(), next = { ...make(), sourceRevision: "unrelated edit", observedAt: "2026-10-25" };
    expect(sameCareerData(old, mergeCareer(old, next, false).career)).toBe(true);
  });
  it("protects a manual month correction, exports its baseline, and accepts unrelated new teams", () => {
    const original = make(), correction = make();
    correction.tenures[0] = { ...correction.tenures[0], start: "2014-03-31", precision: "month", manual: { fields: ["start", "precision"], source: "https://www.hltv.org/player/1/example", checkedAt: "2026-10-24", note: "Mar 2014 - Jan 2015" } };
    const edited = mergeCareer(original, correction, true).career;
    expect(edited.tenures[0].sourceSnapshot?.start).toBe("2014-12-31");
    expect(sameCareerData(edited, mergeCareer(edited, original, false).career)).toBe(true);
    const next = make(); next.tenures.push({ ...next.tenures[0], team: "B", teamId: "B" });
    const result = mergeCareer(edited, next, false);
    expect(result.conflict).toBe(false);
    expect(result.career.tenures[0].start).toBe("2014-03-31");
    expect(result.career.tenures).toHaveLength(2);
    expect(careerSchema.parse(JSON.parse(JSON.stringify(result.career)))).toEqual(result.career);
  });
  it("flags conflicting source edits without overwriting the protected value", () => {
    const correction = make(); correction.tenures[0].start = "2014-03-31";
    const edited = mergeCareer(make(), correction, true).career;
    const fresh = make(); fresh.tenures[0].start = "2014-04-30";
    const result = mergeCareer(edited, fresh, false);
    expect(result.conflict).toBe(true);
    expect(result.career.tenures[0].start).toBe("2014-03-31");
    expect(result.career.syncWarnings?.join()).toContain("start");
  });
  it("updates only the unprotected endpoint of an open tenure", () => {
    const original = make(); original.tenures[0].rawDates = "2014 — Present";
    const correction = structuredClone(original); correction.tenures[0].start = "2014-03-31";
    const edited = mergeCareer(original, correction, true).career;
    const fresh = structuredClone(original); fresh.tenures[0].end = "2026-10-26";
    const result = mergeCareer(edited, fresh, false);
    expect(result.career.tenures[0].start).toBe("2014-03-31");
    expect(result.career.tenures[0].end).toBe("2026-10-26");
  });
  it("retains missing source rows and flags them instead of deleting manual history", () => {
    const result = mergeCareer(make(), { ...make(), tenures: [] }, false);
    expect(result.conflict).toBe(true);
    expect(result.career.tenures).toHaveLength(1);
  });
  it("does not use list positions to match repeated team memberships", () => {
    const old = make(); old.tenures.push({ ...old.tenures[0], start: "2018-01-01", end: "2019-01-01", rawDates: "2018 — 2019" });
    const next = structuredClone(old); next.tenures.reverse();
    const result = mergeCareer(old, next, false);
    expect(result.conflict).toBe(false);
    expect(result.career.tenures).toEqual(old.tenures);
  });
  it("refuses ambiguous return spells and changed person identities", () => {
    const old = make(); old.tenures.push({ ...old.tenures[0], start: "2018-01-01", end: "2019-01-01", rawDates: "2018 — 2019" });
    const next = make(); next.tenures[0] = { ...next.tenures[0], start: null, end: null, rawDates: "?" };
    expect(mergeCareer(old, next, false).conflict).toBe(true);
    expect(mergeCareer(old, { ...next, personKey: "other" }, false).career.personKey).toBe(old.personKey);
  });
});
