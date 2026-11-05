import { useState } from "react";
import { useTranslation } from "react-i18next";
import "./career-timeline.css";

export type Career = {
  aliases?: string[];
  page: string;
  observedAt: string;
  sourceRevision: string;
  locked: boolean;
  syncWarnings?: string[];
  tenures: {
    team: string;
    teamId: string;
    game: string;
    start: string | null;
    end: string | null;
    status: string;
    precision: string;
    rawDates: string;
    source: string;
    verified: boolean;
    manual?: { fields: string[]; source: string; checkedAt: string; note: string };
  }[];
};

export const needsInspection = (t: Career["tenures"][number]) =>
  !t.start || !t.end || !["day", "month"].includes(t.precision) || t.start >= t.end || t.status === "unknown";
export function overlappingOrdinals(career: Career) {
  const indices = new Set<number>();
  career.tenures.forEach((t, i) => {
    if (t.status !== "active" || !t.start || !t.end || t.start >= t.end) return;
    career.tenures.slice(0, i).forEach((u, j) => {
      if (u.status === "active" && u.teamId !== t.teamId && u.start && u.end && u.start < t.end! && t.start! < u.end) { indices.add(i); indices.add(j); }
    });
  });
  return indices;
}

export default function CareerTimeline({ career }: { career: Career | null }) {
  const { t } = useTranslation();
  const [issuesOnly, setIssuesOnly] = useState(false);
  const tr = (key: string) => t(`card.careerView.${key}`);
  if (!career) return <p className="cl-career-note">{tr("missing")}</p>;
  const overlaps = overlappingOrdinals(career);
  const issueCount = career.tenures.filter((t, i) => needsInspection(t) || overlaps.has(i)).length;
  const period = (tenure: Career["tenures"][number]) => {
    const format = (value: string | null) => !value ? tr("unknown") : value.slice(0, tenure.precision === "year" ? 4 : tenure.precision === "month" ? 7 : 10);
    return `${format(tenure.start)} → ${/\bpresent\b/i.test(tenure.rawDates) ? "Present" : format(tenure.end)}`;
  };
  return <section className="cl-career">
    <div className="cl-career-summary">
      <span>{tr("count")} <strong>{career.tenures.length}</strong></span>
      <span className={issueCount ? "cl-career-warning" : ""}>{t("card.careerView.issueCount", { count: issueCount })}</span>
      <span>{t("card.careerView.protectedCount", { count: career.tenures.filter(t => t.manual).length })}</span>
    </div>
    <details className="cl-career-metadata"><summary>{tr("metadata")}</summary>
      <dl className="cl-career-meta">
        <div><dt>{tr("observed")}</dt><dd>{career.observedAt || tr("unknown")}</dd></div>
        <div><dt>{tr("sourcePage")}</dt><dd><a href={career.page} target="_blank" rel="noreferrer">{tr("viewSource")} ↗</a></dd></div>
        <div><dt>{tr("locked")}</dt><dd>{tr(career.locked ? "yes" : "no")}</dd></div>
        <div className="cl-career-revision"><dt>{tr("revision")}</dt><dd>{career.sourceRevision || "—"}</dd></div>
      </dl>
      <p className="cl-career-note">{tr("explanation")}</p>
    </details>
    {!!career.syncWarnings?.length && <ul className="cl-career-warning">{career.syncWarnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul>}
    <div className="cl-toolbar cl-tenure-filters">
      <button type="button" className="btn btn-ghost" aria-pressed={!issuesOnly} onClick={() => setIssuesOnly(false)}>{tr("allTenures")}</button>
      <button type="button" className="btn btn-ghost" aria-pressed={issuesOnly} onClick={() => setIssuesOnly(true)}>{tr("issuesOnly")} · {issueCount}</button>
    </div>
    <p className="cl-career-note">{tr("teammateRule")}</p>
    <p className="cl-career-note">{tr("periodNote")}</p>
    {!career.tenures.length ? <p>{tr("empty")}</p> : issuesOnly && !issueCount ? <p>{tr("noIssues")}</p> :
      <div className="cl-career-scroll" role="region" aria-label={tr("table")} tabIndex={0}>
        <table className="cl-career-table">
          <caption>{tr("table")} · {career.tenures.length}</caption>
          <thead><tr>{["team", "period", "status", "details"].map(key => <th scope="col" key={key}>{tr(key)}</th>)}</tr></thead>
          <tbody>{career.tenures.map((tenure, index) => {
            if (issuesOnly && !needsInspection(tenure) && !overlaps.has(index)) return null;
            const present = /\bpresent\b/i.test(tenure.rawDates);
            const emptyInterval = !!tenure.start && !!tenure.end && tenure.start >= tenure.end;
            return <tr key={index}>
              <th scope="row"><strong>{tenure.team}</strong><small>#{index + 1} · {tenure.game === "csgo" ? "CS:GO" : tenure.game === "cs2" ? "CS2" : tenure.game}</small></th>
              <td><span className="cl-career-date">{period(tenure)}</span><small className={needsInspection(tenure) ? "cl-career-warning" : ""}>{t(`card.careerView.precisions.${tenure.precision}`, { defaultValue: tenure.precision })}{emptyInterval && ` · ${tr("emptyInterval")}`}</small></td>
              <td>{t(`card.careerView.statuses.${tenure.status}`, { defaultValue: tenure.status })}{overlaps.has(index) && <small className="cl-career-warning">{tr("overlap")}</small>}</td>
              <td><details><summary>{tenure.manual ? tr("manual") : tr("details")}</summary>
                <dl className="cl-tenure-evidence">
                  <dt>{tr("raw")}</dt><dd>{tenure.rawDates || tr("unknown")}</dd>
                  <dt>{tr("start")}</dt><dd>{tenure.start || tr("unknown")}</dd>
                  <dt>{tr("end")}</dt><dd>{tenure.end || tr("unknown")}</dd>
                </dl>
                {present && <p className="cl-career-note">{tr("present")} · {career.observedAt}<br />{tr("cutoff")}</p>}
                {!["day", "month"].includes(tenure.precision) && <p className="cl-career-warning">{tr("uncertain")}</p>}
                <p>{tr(tenure.verified ? "verified" : "unverified")}</p>
                {tenure.teamId !== tenure.team && <small>{tenure.teamId}</small>}
                <a href={tenure.source} target="_blank" rel="noreferrer" aria-label={`${tenure.team} · ${index + 1} · ${tr("viewSource")}`}>{tr("viewSource")} ↗</a>
                {tenure.manual && <div className="cl-manual-evidence"><a href={tenure.manual.source} target="_blank" rel="noreferrer">{tr("evidence")} ↗</a><small>{tenure.manual.checkedAt} · {tenure.manual.fields.join(", ")}</small><p>{tenure.manual.note}</p></div>}
              </details></td>
            </tr>;
          })}</tbody>
        </table>
      </div>}
  </section>;
}
