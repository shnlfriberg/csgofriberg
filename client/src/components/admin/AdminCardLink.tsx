import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { api, errMsg } from "../../api/client";
import "../../card-link/style.css";
import CareerTimeline, { type Career } from "./CareerTimeline";
import CareerPicker, { type CareerRow } from "./CareerPicker";
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
export default function AdminCardLink() {
  const [rollbackReason, setRollbackReason] = useState('');
  const { t } = useTranslation(),
    tr = (k: string) => t(`card.${k}`);
  const [players, setPlayers] = useState<CareerRow[]>([]),
    [reviews, setReviews] = useState<Review[]>([]),
    [graphs, setGraphs] = useState<Graphs | null>(null),
    [selected, setSelected] = useState<CareerRow | null>(null),
    [draft, setDraft] = useState(""),
    [draftRevision, setDraftRevision] = useState(0),
    [drafts, setDrafts] = useState<Record<number, { text: string; revision: number }>>({}),
    [tab, setTab] = useState("careers"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [page, setPage] = useState(0),
    [previews, setPreviews] = useState<Record<string, Preview>>({});
  useEffect(() => {
    let cancelled = false;
    api.get("/admin/card-link/careers").then(({ data }) => {
      if (!cancelled) setPlayers(data);
    }).catch(e => { if (!cancelled) setError(errMsg(e)); });
    return () => { cancelled = true; };
  }, []);
  const loadCareers = async () => {
    const { data } = await api.get<CareerRow[]>("/admin/card-link/careers");
    setPlayers(data);
    setSelected(old => old ? data.find(p => p.playerId === old.playerId) ?? null : null);
  };
  const run = async (fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(e instanceof SyntaxError ? e.message : errMsg(e));
    } finally {
      setBusy(false);
    }
  };
  const loadReviews = async (p = page) =>
    setReviews(
      (await api.get("/admin/card-link/reviews", { params: { page: p } })).data,
    );
  const loadGraphs = async () =>
    setGraphs((await api.get("/admin/card-link/graphs")).data);
  return (
    <section className="cl-admin">
      <h2>{tr("admin")}</h2>
      {error && <p role="alert">{error}</p>}
      <div className="cl-toolbar cl-admin-tabs">
        <button
          className="btn btn-ghost"
          disabled={busy}
          aria-pressed={tab === "careers"}
          onClick={() => { setTab("careers"); void run(loadCareers); }}
        >
          {tr("careers")}
        </button>
        <button
          className="btn btn-ghost"
          disabled={busy}
          aria-pressed={tab === "reviews"}
          onClick={() => { setTab("reviews"); void run(() => loadReviews()); }}
        >
          {tr("reviews")}
        </button>
        <button className="btn btn-ghost" disabled={busy} aria-pressed={tab === "graphs"} onClick={() => { setTab("graphs"); void run(loadGraphs); }}>
          {tr("graphs")}
        </button>
      </div>
      <div className="cl-career-workspace" hidden={tab !== "careers"}>
      <CareerPicker players={players} selectedId={selected?.playerId} onSelect={p => {
        if (selected?.playerId === p.playerId) return;
        if (selected) setDrafts(old => ({ ...old, [selected.playerId]: { text: draft, revision: draftRevision } }));
        setSelected(p);
        setDraftRevision(drafts[p.playerId]?.revision ?? p.revision);
        setDraft(drafts[p.playerId]?.text ?? JSON.stringify(p.career ?? {
          personKey: "", page: "", sourceRevision: "manual", observedAt: new Date().toISOString().slice(0, 10), aliases: [], tenures: [], locked: true,
        }, null, 2));
      }} />
      <div className="cl-career-detail">
      {!selected && <div className="cl-career-empty">{tr("careerView.chooseHint")}</div>}
      {selected && (
        <>
          <h3>
            {selected.nickname} · #{selected.playerId} · v{selected.revision} · {tr("careerView.approved")}
          </h3>
          <CareerTimeline career={selected.career} />
          <details className="cl-career-editor">
          <summary>{tr("careerView.edit")} · v{draftRevision}</summary>
          <p className="cl-career-note">{tr("careerView.draftNote")}</p>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            aria-label={tr("careers")}
          />
          <button
            className="btn"
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
                setTab("reviews");
              })
            }
          >
            {tr("save")}
          </button>
          </details>
        </>
      )}
      </div></div>
      {tab === "reviews" && !reviews.length && <p>{tr("careerView.noReviews")}</p>}
      {tab === "reviews" && reviews.map((r) => (
        <article key={r.id}>
          <h3>
            #{r.player_id} · {r.status} · v{r.expected_revision}
          </h3>
          <CareerTimeline career={JSON.parse(r.payload)} />
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                const data = (
                  await api.get(`/admin/card-link/reviews/${r.id}/preview`)
                ).data;
                setPreviews((old) => ({ ...old, [r.id]: data }));
              })
            }
          >
            {tr("preview")}
          </button>
          {previews[r.id] && (
            <details open>
              <summary>{tr("preview")}</summary>
              <p>
                ＋{" "}
                {previews[r.id].added.map((p) => p.nickname).join(", ") || "—"}
              </p>
              <p>
                −{" "}
                {previews[r.id].removed.map((p) => p.nickname).join(", ") ||
                  "—"}
              </p>
              <CareerTimeline career={previews[r.id].before} />
            </details>
          )}
          <details>
            <summary>JSON</summary>
            <pre>{JSON.stringify(JSON.parse(r.payload), null, 2)}</pre>
          </details>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.post(`/admin/card-link/reviews/${r.id}`, {
                  approve: true,
                });
                await loadReviews();
                await loadCareers();
              })
            }
          >
            {tr("approve")}
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.post(`/admin/card-link/reviews/${r.id}`, {
                  approve: false,
                });
                await loadReviews();
              })
            }
          >
            {tr("reject")}
          </button>
        </article>
      ))}
      {tab === "reviews" && (!!reviews.length || page > 0) && (
        <div className="cl-toolbar">
          <button
            className="btn"
            disabled={busy || page === 0}
            onClick={() =>
              run(async () => {
                setPage(page - 1);
                await loadReviews(page - 1);
              })
            }
          >
            ←
          </button>
          <span>{page + 1}</span>
          <button
            className="btn"
            disabled={busy || reviews.length < 50}
            onClick={() =>
              run(async () => {
                setPage(page + 1);
                await loadReviews(page + 1);
              })
            }
          >
            →
          </button>
        </div>
      )}
      {tab === "graphs" && graphs && (
        <>
          <p>
            {tr("graphs")} · v{graphs.catalog.revision} ·{" "}
            {graphs.catalog.enabled ? "✓" : "—"}
          </p>
          <button
            className="btn"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.post("/admin/card-link/build", {});
                await loadGraphs();
              })
            }
          >
            {tr("build")}
          </button>
          <button
            className="btn btn-ghost"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.post("/admin/card-link/enabled", {
                  enabled: !graphs.catalog.enabled,
                });
                await loadGraphs();
              })
            }
          >
            {tr(graphs.catalog.enabled ? "disabled" : "enabled")}
          </button>
          {graphs.jobs?.map((j) => (
            <p key={j.id}>
              {j.status}: {j.result}
            </p>
          ))}
          <fieldset disabled={busy}>
            <legend>{tr('sceneAccess')}</legend>
            {(['practice', 'daily', 'friend', 'ranked'] as const).map(scene => <label key={scene} style={{ marginRight: 16 }}>
              <input type="checkbox" checked={graphs.catalog[`${scene}_enabled`] == null || Boolean(graphs.catalog[`${scene}_enabled`])}
                onChange={e => { const enabled = e.target.checked; void run(async () => {
                  await api.post('/admin/card-link/enabled', { scenes: { [scene]: enabled } }); await loadGraphs();
                }); }} /> {tr(scene)}
            </label>)}
          </fieldset>
          <label>{tr('rollbackReason')} <input value={rollbackReason} maxLength={300} onChange={e => setRollbackReason(e.target.value)} /></label>
          {graphs.graphs.map((g) => (
            <article key={g.version}>
              <code>{g.version.slice(0, 16)}</code> · v{g.source_revision}{" "}
              <button
                className="btn"
                disabled={busy || !g.source_hash || g.source_revision !== graphs.catalog.revision}
                onClick={() =>
                  run(async () => {
                    await api.post("/admin/card-link/publish", {
                      version: g.version,
                    });
                    await loadGraphs();
                  })
                }
              >
                {tr("publish")}
              </button>
              {!!g.published_at && g.version !== graphs.catalog.graph_version && <button className="btn btn-ghost"
                disabled={busy || !rollbackReason.trim()} onClick={() => void run(async () => {
                  await api.post('/admin/card-link/rollback', { version: g.version, expectedVersion: graphs.catalog.graph_version, reason: rollbackReason.trim() });
                  setRollbackReason(''); await loadGraphs();
                })}>{tr('rollback')}</button>}
            </article>
          ))}
          {graphs.outbox.map((o) => (
            <p key={o.match_id}>
              {o.match_id}: {o.error}
              <button
                className="btn"
                disabled={busy}
                onClick={() =>
                  run(async () => {
                    await api.post(
                      `/admin/card-link/outbox/${o.match_id}/retry`,
                      {},
                    );
                    await loadGraphs();
                  })
                }
              >
                {tr("retry")}
              </button>
            </p>
          ))}
          <details><summary>{tr('operationLog')}</summary>{graphs.events?.map(e => <p key={e.id}>{new Date(Number(e.created_at)).toLocaleString()} · {e.action} · #{e.actor ?? '—'} <code>{e.payload}</code></p>)}</details>
          {graphs.monitoring != null && <details><summary>{tr('monitoring')}</summary><pre>{JSON.stringify(graphs.monitoring, null, 2)}</pre></details>}
        </>
      )}
    </section>
  );
}
