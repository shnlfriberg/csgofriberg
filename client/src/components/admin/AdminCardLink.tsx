import { useEffect, useRef, useState } from "react";
import { Check, Eye, Hammer, Power, RotateCcw, Send, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { api, errMsg } from "../../api/client";
import { currentLocale } from "../../i18n";
import "../../card-link/style.css";
import Badge from "../Badge";
import CareerTimeline, { type Career } from "./CareerTimeline";
import CareerPicker, { type CareerRow } from "./CareerPicker";
import type { CardTab } from "./nav";
import { Panel, SimplePager, formatDateTime } from "./ui";

type Preview = {
  before: Career | null;
  after: Career;
  added: { id: number; nickname: string }[];
  removed: { id: number; nickname: string }[];
};
type Review = {
  id: string;
  player_id: number;
  status: string;
  payload: string;
  expected_revision: number;
};
type Graphs = {
  catalog: { revision: number; enabled: boolean; graph_version: string | null } & Partial<Record<'practice_enabled' | 'daily_enabled' | 'friend_enabled' | 'ranked_enabled', boolean>>;
  graphs: { version: string; source_revision: number; created_at: number; source_hash?: string | null; published_at?: number | null }[];
  events?: { id: string; action: string; actor: number | null; payload: string; created_at: number }[];
  monitoring?: unknown;
  outbox: { match_id: string; error: string }[];
  jobs?: { id: string; status: string; result: string | null }[];
};
const SCENES = ['practice', 'daily', 'friend', 'ranked'] as const;
const REVIEW_PAGE = 50;

/** Card Link data administration: careers, the career review queue and graph versions. */
export default function AdminCardLink({ tab = "careers" }: { tab?: CardTab }) {
  const { t } = useTranslation();
  const tr = (k: string) => t(`card.${k}`);
  const locale = currentLocale();
  const [players, setPlayers] = useState<CareerRow[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [graphs, setGraphs] = useState<Graphs | null>(null);
  const [selected, setSelected] = useState<CareerRow | null>(null);
  const [draft, setDraft] = useState("");
  const [draftRevision, setDraftRevision] = useState(0);
  const [drafts, setDrafts] = useState<Record<number, { text: string; revision: number }>>({});
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [page, setPage] = useState(0);
  const [previews, setPreviews] = useState<Record<string, Preview>>({});
  const [rollbackReason, setRollbackReason] = useState('');
  const busyRef = useRef(false);

  const run = async (fn: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof SyntaxError ? e.message : errMsg(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const loadCareers = async () => {
    const { data } = await api.get<CareerRow[]>("/admin/card-link/careers");
    setPlayers(data);
    setSelected(old => old ? data.find(p => p.playerId === old.playerId) ?? null : null);
  };
  const loadReviews = async (p = page) =>
    setReviews((await api.get<Review[]>("/admin/card-link/reviews", { params: { page: p } })).data);
  const loadGraphs = async () =>
    setGraphs((await api.get<Graphs>("/admin/card-link/graphs")).data);

  // Each tool refreshes its data when opened (careers also feed reviewer names).
  useEffect(() => {
    if (tab === "careers") void run(loadCareers);
    if (tab === "reviews") void run(async () => { await loadReviews(); if (!players.length) await loadCareers(); });
    if (tab === "graphs") void run(loadGraphs);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab]);

  const choose = (p: CareerRow) => {
    if (selected?.playerId === p.playerId) return;
    if (selected) setDrafts(old => ({ ...old, [selected.playerId]: { text: draft, revision: draftRevision } }));
    setSelected(p);
    setDraftRevision(drafts[p.playerId]?.revision ?? p.revision);
    setDraft(drafts[p.playerId]?.text ?? JSON.stringify(p.career ?? {
      personKey: "", page: "", sourceRevision: "manual", observedAt: new Date().toISOString().slice(0, 10), aliases: [], tenures: [], locked: true,
    }, null, 2));
  };

  const sceneOn = (scene: typeof SCENES[number]) => {
    const value = graphs?.catalog[`${scene}_enabled`];
    return value == null || Boolean(value);
  };

  return (
    <section className="cl-admin" aria-label={tr("admin")}>
      {error && <p role="alert" className="location-alert">{error}</p>}
      {notice && <p role="status" className="admin-callout">{notice}</p>}

      <div className="cl-career-workspace" hidden={tab !== "careers"}>
        <div className="admin-panel cl-career-picker-panel">
          <CareerPicker players={players} selectedId={selected?.playerId} onSelect={choose} />
        </div>
        <div className="cl-career-detail">
          {!selected ? (
            <div className="admin-panel"><p className="admin-empty">{tr("careerView.chooseHint")}</p></div>
          ) : (
            <Panel
              id="cl-career-title"
              title={selected.nickname}
              description={`#${selected.playerId} · v${selected.revision} · ${tr("careerView.approved")}`}
            >
              <CareerTimeline career={selected.career} />
              <details className="cl-career-editor">
                <summary>{tr("careerView.edit")} · v{draftRevision}</summary>
                <p className="admin-help">{tr("careerView.draftNote")}</p>
                <textarea
                  className="input admin-code-input"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  aria-label={tr("careers")}
                />
                <div className="admin-form-actions">
                  <button
                    className="btn btn-sm"
                    disabled={busy}
                    onClick={() =>
                      run(async () => {
                        await api.post("/admin/card-link/careers", {
                          playerId: selected.playerId,
                          expectedRevision: draftRevision,
                          career: JSON.parse(draft),
                          requestId: crypto.randomUUID(),
                        });
                        await loadReviews();
                        setNotice(t("adminUi.careerSubmitted"));
                      })
                    }
                  >
                    <Send size={15} aria-hidden="true" />{tr("save")}
                  </button>
                </div>
              </details>
            </Panel>
          )}
        </div>
      </div>

      {tab === "reviews" && (
        <Panel id="cl-reviews-title" title={tr("reviews")} flush>
          {!reviews.length ? <p className="admin-empty">{busy ? t("common.loading") : tr("careerView.noReviews")}</p> : (
            <div className="cl-review-list">
              {reviews.map((r) => {
                const payload = JSON.parse(r.payload) as Career;
                const preview = previews[r.id];
                return (
                  <article className="cl-review" key={r.id}>
                    <header className="cl-review-head">
                      <div>
                        <strong>{players.find(p => p.playerId === r.player_id)?.nickname ?? `#${r.player_id}`}</strong>
                        <span className="admin-badges">
                          <span className="admin-mono">#{r.player_id} · v{r.expected_revision}</span>
                          <Badge text={t(r.status === "conflict" ? "adminUi.reviewConflict" : "adminUi.reviewPending")} color={r.status === "conflict" ? "gray" : "amber"} />
                        </span>
                      </div>
                      <div className="admin-panel-actions">
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => run(async () => {
                            const data = (await api.get<Preview>(`/admin/card-link/reviews/${r.id}/preview`)).data;
                            setPreviews((old) => ({ ...old, [r.id]: data }));
                          })}
                        >
                          <Eye size={15} aria-hidden="true" />{tr("preview")}
                        </button>
                        <button
                          className="btn btn-ghost btn-sm"
                          disabled={busy}
                          onClick={() => run(async () => {
                            await api.post(`/admin/card-link/reviews/${r.id}`, { approve: false });
                            await loadReviews();
                          })}
                        >
                          <X size={15} aria-hidden="true" />{tr("reject")}
                        </button>
                        <button
                          className="btn btn-sm"
                          disabled={busy}
                          onClick={() => run(async () => {
                            await api.post(`/admin/card-link/reviews/${r.id}`, { approve: true });
                            await loadReviews();
                            await loadCareers();
                          })}
                        >
                          <Check size={15} aria-hidden="true" />{tr("approve")}
                        </button>
                      </div>
                    </header>
                    {preview && (
                      <div className="admin-callout cl-review-preview">
                        <p><strong>＋</strong> {preview.added.map((p) => p.nickname).join(", ") || "—"}</p>
                        <p><strong>−</strong> {preview.removed.map((p) => p.nickname).join(", ") || "—"}</p>
                        <details>
                          <summary>{tr("preview")}</summary>
                          <CareerTimeline career={preview.before} />
                        </details>
                      </div>
                    )}
                    <CareerTimeline career={payload} />
                    <details className="cl-review-json">
                      <summary>JSON</summary>
                      <pre>{JSON.stringify(payload, null, 2)}</pre>
                    </details>
                  </article>
                );
              })}
            </div>
          )}
          {(reviews.length >= REVIEW_PAGE || page > 0) && (
            <SimplePager
              page={page + 1}
              hasNext={reviews.length >= REVIEW_PAGE}
              loading={busy}
              onPage={(next) => run(async () => {
                setPage(next - 1);
                await loadReviews(next - 1);
              })}
            />
          )}
        </Panel>
      )}

      {tab === "graphs" && graphs && (
        <div className="admin-stack">
          <Panel
            id="cl-graph-status"
            title={t("adminUi.graphStatus")}
            actions={(
              <>
                <button
                  className="btn btn-ghost btn-sm"
                  disabled={busy}
                  onClick={() => run(async () => {
                    await api.post("/admin/card-link/enabled", { enabled: !graphs.catalog.enabled });
                    await loadGraphs();
                  })}
                >
                  <Power size={15} aria-hidden="true" />{tr(graphs.catalog.enabled ? "disabled" : "enabled")}
                </button>
                <button
                  className="btn btn-sm"
                  disabled={busy}
                  onClick={() => run(async () => {
                    await api.post("/admin/card-link/build", {});
                    await loadGraphs();
                  })}
                >
                  <Hammer size={15} aria-hidden="true" />{tr("build")}
                </button>
              </>
            )}
          >
            <div className="cl-graph-status">
              <dl className="admin-kv">
                <dt>{t("adminUi.graphCatalog")}</dt><dd>v{graphs.catalog.revision}</dd>
                <dt>{t("adminUi.graphPublished")}</dt><dd className="admin-mono">{graphs.catalog.graph_version?.slice(0, 16) ?? "—"}</dd>
                <dt>{tr("graphs")}</dt>
                <dd><Badge text={graphs.catalog.enabled ? t("adminUi.enabledState") : t("adminUi.disabledState")} color={graphs.catalog.enabled ? "green" : "gray"} /></dd>
              </dl>
              <fieldset className="cl-scene-switches" disabled={busy}>
                <legend>{tr("sceneAccess")}</legend>
                {SCENES.map(scene => (
                  <label className="admin-switch" key={scene}>
                    <input
                      type="checkbox"
                      checked={sceneOn(scene)}
                      onChange={e => {
                        const enabled = e.target.checked;
                        void run(async () => {
                          await api.post('/admin/card-link/enabled', { scenes: { [scene]: enabled } });
                          await loadGraphs();
                        });
                      }}
                    />
                    <span>{tr(scene)}</span>
                  </label>
                ))}
              </fieldset>
            </div>
            {!!graphs.jobs?.length && (
              <ul className="admin-status-list cl-graph-jobs" aria-label={t("adminUi.graphJobs")}>
                {graphs.jobs.map((j) => <li key={j.id}><span className="admin-mono">{j.id}</span><span>{j.status}{j.result ? ` · ${j.result}` : ''}</span></li>)}
              </ul>
            )}
          </Panel>

          <Panel
            id="cl-graph-versions"
            title={t("adminUi.graphVersions")}
            flush
            actions={(
              <label className="admin-filter cl-rollback-reason">
                <span>{tr('rollbackReason')}</span>
                <input className="input" value={rollbackReason} maxLength={300} onChange={e => setRollbackReason(e.target.value)} />
              </label>
            )}
          >
            <div className="admin-table">
              <div>
                <table className="cl-graph-table">
                  <thead>
                    <tr>
                      <th>{t("adminUi.versionDetails")}</th>
                      <th>{t("adminUi.graphSource")}</th>
                      <th>{t("adminUi.graphBuiltAt")}</th>
                      <th>{t("adminUi.statusColumn")}</th>
                      <th>{t("admin.actions")}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {graphs.graphs.map((g) => {
                      const live = g.version === graphs.catalog.graph_version;
                      return (
                        <tr key={g.version}>
                          <td><code className="admin-mono">{g.version.slice(0, 16)}</code></td>
                          <td className="admin-num">v{g.source_revision}</td>
                          <td>{g.created_at ? formatDateTime(Number(g.created_at), locale) : "—"}</td>
                          <td>
                            {live
                              ? <Badge text={t("adminUi.graphLive")} color="green" />
                              : g.published_at ? <Badge text={tr("publish")} color="gray" /> : <span className="muted">—</span>}
                          </td>
                          <td>
                            <span className="admin-row-actions">
                              <button
                                className="admin-action"
                                disabled={busy || !g.source_hash || g.source_revision !== graphs.catalog.revision}
                                onClick={() => run(async () => {
                                  await api.post("/admin/card-link/publish", { version: g.version });
                                  await loadGraphs();
                                })}
                              >
                                {tr("publish")}
                              </button>
                              {!!g.published_at && !live && (
                                <button
                                  className="admin-action is-danger"
                                  disabled={busy || !rollbackReason.trim()}
                                  title={rollbackReason.trim() ? undefined : tr('rollbackReason')}
                                  onClick={() => void run(async () => {
                                    await api.post('/admin/card-link/rollback', { version: g.version, expectedVersion: graphs.catalog.graph_version, reason: rollbackReason.trim() });
                                    setRollbackReason('');
                                    await loadGraphs();
                                  })}
                                >
                                  <RotateCcw size={14} aria-hidden="true" />{tr('rollback')}
                                </button>
                              )}
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          </Panel>

          {graphs.outbox.length > 0 && (
            <Panel id="cl-graph-outbox" title={t("adminUi.graphOutbox")} flush>
              <ul className="admin-status-list cl-outbox-list">
                {graphs.outbox.map((o) => (
                  <li key={o.match_id}>
                    <span><code className="admin-mono">{o.match_id}</code> · {o.error}</span>
                    <button
                      className="admin-action"
                      disabled={busy}
                      onClick={() => run(async () => {
                        await api.post(`/admin/card-link/outbox/${o.match_id}/retry`, {});
                        await loadGraphs();
                      })}
                    >
                      {tr("retry")}
                    </button>
                  </li>
                ))}
              </ul>
            </Panel>
          )}

          <Panel id="cl-graph-log" title={tr('operationLog')}>
            {graphs.events?.length ? (
              <ul className="admin-status-list cl-event-list">
                {graphs.events.map(e => (
                  <li key={e.id}>
                    <span>{formatDateTime(Number(e.created_at), locale)} · {e.action} · #{e.actor ?? '—'}</span>
                    <code className="admin-mono">{e.payload}</code>
                  </li>
                ))}
              </ul>
            ) : <p className="admin-help">—</p>}
            {graphs.monitoring != null && (
              <details className="cl-monitoring">
                <summary>{tr('monitoring')}</summary>
                <pre>{JSON.stringify(graphs.monitoring, null, 2)}</pre>
              </details>
            )}
          </Panel>
        </div>
      )}
      {tab === "graphs" && !graphs && !error && <p className="admin-loading" role="status">{t("common.loading")}</p>}
    </section>
  );
}
