import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { needsInspection, overlappingOrdinals, type Career } from "./CareerTimeline";

export type CareerRow = { playerId: number; nickname: string; enabled: boolean; revision: number; career: Career | null };
export const careerGaps = (career: Career | null) => career?.tenures.filter(t => !t.start || !t.end || !["day", "month"].includes(t.precision)).length ?? 0;
const normalize = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s@_\-]/g, "");
export default function CareerPicker({ players, selectedId, onSelect }: { players: CareerRow[]; selectedId?: number; onSelect: (row: CareerRow) => void }) {
  const { t } = useTranslation();
  const tr = (key: string) => t(`card.careerView.${key}`);
  const [query, setQuery] = useState(""), [filter, setFilter] = useState("enabled"), [page, setPage] = useState(0);
  const entries = useMemo(() => players.map(row => ({ row, gaps: careerGaps(row.career), issues: row.career ? row.career.tenures.some(needsInspection) || overlappingOrdinals(row.career).size > 0 || !!row.career.syncWarnings?.length : true, search: normalize([row.nickname, ...(row.career?.aliases ?? []), ...(row.career?.tenures.map(t => t.team) ?? [])].join(" ")) })), [players]);
  const results = useMemo(() => {
    const q = normalize(query.trim()), id = query.trim().replace(/^#/, "");
    return entries.filter(({row, gaps, issues, search}) =>
      (filter !== "enabled" || row.enabled) && (filter !== "gaps" || gaps > 0 || !row.career) &&
      (filter !== "issues" || issues) &&
      (filter !== "manual" || row.career?.tenures.some(t => t.manual)) &&
      (!q || String(row.playerId) === id || search.includes(q)))
      .sort((a, b) => {
        const rank = (row: CareerRow) => String(row.playerId) === id ? 0 : normalize(row.nickname) === q ? 1 : normalize(row.nickname).startsWith(q) ? 2 : 3;
        return rank(a.row) - rank(b.row) || Number(b.row.enabled) - Number(a.row.enabled) || a.row.nickname.localeCompare(b.row.nickname);
      });
  }, [entries, query, filter]);
  const pages = Math.max(1, Math.ceil(results.length / 12)), shownPage = Math.min(page, pages - 1);
  return <aside className="cl-player-browser" aria-label={tr("select")}>
    <label htmlFor="cl-player-search">{tr("searchMore")}</label>
    <input id="cl-player-search" type="search" value={query} placeholder={tr("searchHint")} onChange={e => { setQuery(e.target.value); setPage(0); }} />
    <label className="cl-filter-label" htmlFor="cl-player-filter">{tr("filter")}</label>
    <select id="cl-player-filter" value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}>
      {["enabled", "all", "gaps", "issues", "manual"].map(k => <option value={k} key={k}>{tr(`filter_${k}`)}</option>)}
    </select>
    <p className="cl-career-note" role="status">{t("card.careerView.results", { count: results.length })}</p>
    <div className="cl-player-results">{results.slice(shownPage * 12, shownPage * 12 + 12).map(({ row, gaps }) =>
      <button key={row.playerId} type="button" className="cl-player-result" aria-pressed={selectedId === row.playerId} onClick={() => onSelect(row)}>
        <span><strong>{row.nickname}</strong>{" "}<small>#{row.playerId}{!row.enabled && ` · ${tr("disabledPlayer")}`}</small></span>
        <small>{!row.career ? tr("missingShort") : gaps ? t("card.careerView.gapCount", { count: gaps }) : tr("monthComplete")}</small>
      </button>)}</div>
    {!results.length && <p>{tr("noResults")}</p>}
    <div className="cl-toolbar cl-picker-pages">
      <button className="btn btn-ghost" aria-label={tr("previous")} disabled={!shownPage} onClick={() => setPage(shownPage - 1)}>←</button>
      <span>{shownPage + 1} / {pages}</span>
      <button className="btn btn-ghost" aria-label={tr("next")} disabled={shownPage + 1 >= pages} onClick={() => setPage(shownPage + 1)}>→</button>
    </div>
  </aside>;
}
