import type { Career } from "./careers";

type Tenure = Career["tenures"][number];
const fields = ["teamId", "team", "game", "start", "end", "precision", "status", "rawDates", "source", "verified"] as const;
type Field = typeof fields[number];
const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export const sourceData = (t: Tenure) => Object.fromEntries(fields.map(k => [k, t[k]])) as Omit<Tenure, "manual" | "sourceSnapshot">;
const base = (t: Tenure) => t.sourceSnapshot ?? sourceData(t);

// Never match by ordinal: a source can insert an older team anywhere in its list.
function matchTenure(t: Tenure, previous: Tenure[], used: Set<number>): number {
  const available = previous.map((p, i) => ({ p, i })).filter(({ i }) => !used.has(i));
  const exact = available.filter(({ p }) => equal(base(p), sourceData(t)) || equal(sourceData(p), sourceData(t)));
  if (exact.length === 1) return exact[0].i;
  if (exact.length > 1 && exact.every(({ p }) => !p.manual && equal(sourceData(p), sourceData(exact[0].p)))) return exact[0].i;
  const group = available.filter(({ p }) => {
    const b = base(p);
    return b.teamId === t.teamId && b.game === t.game && b.status === t.status;
  });
  const anchored = group.filter(({ p }) => {
    const b = base(p);
    return (b.start && b.start === t.start) || (b.end && b.end === t.end) || b.rawDates === t.rawDates;
  });
  if (anchored.length === 1) return anchored[0].i;
  return group.length === 1 ? group[0].i : -1;
}

export function sameCareerData(a: Career, b: Career): boolean {
  // Page revision/observation-only changes are not a new career. Open-ended
  // tenures still update because their actual calculation endpoint changes.
  return equal([a.personKey, a.page, a.aliases, a.locked, a.tenures, a.syncWarnings ?? []],
    [b.personKey, b.page, b.aliases, b.locked, b.tenures, b.syncWarnings ?? []]);
}

export function mergeCareer(previous: Career | null, incoming: Career, admin: boolean): { career: Career; conflict: boolean } {
  if (!previous) return { career: { ...incoming, tenures: incoming.tenures.map(t => admin ? t : sourceData(t)), ...(admin ? {} : { locked: false, syncWarnings: [] }) }, conflict: false };
  if (!admin && previous.personKey !== incoming.personKey)
    return { career: { ...previous, syncWarnings: ["人物来源身份不同，禁止自动合并。"] }, conflict: true };
  const used = new Set<number>();
  const warnings: string[] = [];
  const tenures: Tenure[] = [];
  const positions = new Map<Tenure, number>();
  for (const fresh of incoming.tenures) {
    const index = matchTenure(admin && fresh.sourceSnapshot ? fresh.sourceSnapshot : fresh, previous.tenures, used);
    if (index < 0) {
      const ambiguous = !admin && previous.tenures.some((p, i) => !used.has(i) && base(p).teamId === fresh.teamId && base(p).game === fresh.game);
      if (ambiguous) { warnings.push(`${fresh.team}：多次入队或身份变化无法唯一匹配，保留旧记录，需人工核对。`); continue; }
      tenures.push(admin ? { ...fresh, manual: fresh.manual ?? { fields: [...fields], source: fresh.source, checkedAt: incoming.observedAt, note: "管理员新增任期；采集不会覆盖这些字段。" } } : sourceData(fresh));
      continue;
    }
    used.add(index);
    const old = previous.tenures[index], original = base(old);
    if (admin) {
      const changed = fields.filter(k => !equal(old[k], fresh[k]));
      if (!changed.length) { tenures.push({ ...old, ...fresh }); continue; }
      const protectedFields = [...new Set([...(old.manual?.fields ?? []), ...(fresh.manual?.fields ?? []), ...changed])];
      tenures.push({ ...fresh, sourceSnapshot: original, manual: {
        fields: protectedFields,
        source: fresh.manual?.source ?? fresh.source,
        checkedAt: fresh.manual?.checkedAt ?? incoming.observedAt,
        note: fresh.manual?.note ?? old.manual?.note ?? "管理员修订；后续采集保留这些字段。",
      } });
    } else {
      const merged = { ...old };
      for (const key of fields) {
        const protectedField = old.manual?.fields.includes(key);
        if (protectedField) {
          if (!equal(fresh[key], original[key]) && !equal(fresh[key], old[key]))
            warnings.push(`${old.team} · ${key}：新来源与人工修订不同，已保留人工值。`);
        } else if (!equal(fresh[key], original[key])) {
          // Assignment through the common keyed record preserves schema types.
          (merged as unknown as Record<Field, unknown>)[key] = fresh[key];
        }
      }
      // Retain the source baseline only for manual overlays; ordinary unchanged
      // rows stay byte-for-byte stable and do not create noisy review revisions.
      if (old.manual) merged.sourceSnapshot = sourceData(fresh);
      tenures.push(merged);
    }
    positions.set(tenures[tenures.length - 1], index);
  }
  if (!admin) previous.tenures.forEach((old, i) => {
    if (!used.has(i)) { tenures.push(old); positions.set(old, i); warnings.push(`${old.team}：新来源未匹配到原任期，保留原记录，需人工核对。`); }
  });
  // Preserve original order for existing entries so upstream reordering does
  // not invalidate manual row references; genuinely new entries are appended.
  if (!admin) tenures.sort((a, b) => (positions.get(a) ?? previous.tenures.length) - (positions.get(b) ?? previous.tenures.length));
  const career = { ...incoming, tenures, locked: admin ? incoming.locked : previous.locked,
    aliases: admin ? incoming.aliases : [...new Set([...previous.aliases, ...incoming.aliases])],
    syncWarnings: admin ? incoming.syncWarnings : [...new Set(warnings)],
  };
  return { career, conflict: warnings.length > 0 };
}
