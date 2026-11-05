import type { Career } from "./careers";

type Tenure = Career["tenures"][number];
type Interval = Tenure & { start: string; end: string };
const eligible = (t: Tenure) =>
  ["active", "loan"].includes(t.status) ||
  (["trial", "standin"].includes(t.status) && t.verified);

/** Keep only certain active intervals. A loan supersedes its parent roster;
 * conflicting employments and inactive periods contribute no speculative edges. */
export function effectiveTenures(tenures: Tenure[]): Interval[] {
  const dated = tenures.filter(
    (t): t is Interval => !!t.start && !!t.end && t.start < t.end,
  );
  return dated.filter(eligible).flatMap((tenure) => {
    let segments = [{ ...tenure }];
    for (const other of dated) {
      if (other === tenure) continue;
      // Bench explicitly suspends a playing roster spot. Staff rows never
      // contribute intervals (eligible above), but must not erase a separate
      // playing tenure: player/owners and playing coaches can hold both roles.
      const inactive = other.teamId === tenure.teamId &&
        other.status === "inactive";
      const conflicting =
        other.teamId !== tenure.teamId &&
        eligible(other) &&
        !(tenure.status === "loan" && other.status === "active");
      if (!inactive && !conflicting) continue;
      segments = segments.flatMap((part) => {
        if (other.end <= part.start || other.start >= part.end) return [part];
        const kept: Interval[] = [];
        if (part.start < other.start) kept.push({ ...part, end: other.start });
        if (other.end < part.end) kept.push({ ...part, start: other.end });
        return kept;
      });
    }
    return segments;
  });
}
