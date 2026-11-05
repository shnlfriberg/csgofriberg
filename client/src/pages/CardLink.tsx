import CardLobby, { lobbyScenes, type LobbyScene } from '../card-link/Lobby';
import { useCardMotion } from "../card-link/useCardMotion";
import { useCardPointerDrag } from "../card-link/useCardPointerDrag";
import ConnectionSlot from "../card-link/ConnectionSlot";
import SolutionRoute from "../card-link/SolutionRoute";
import DifficultyRules from "../card-link/DifficultyRules";
import PlayerCardFace from "../card-link/PlayerCardFace";
import MatchClock from '../card-link/MatchClock';
import ConnectionStatus from '../card-link/ConnectionStatus';
import RoundResult from '../card-link/RoundResult';
import CardDailyLeaderboard from '../card-link/DailyLeaderboard';
import { useAuth } from '../store/auth';
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import type { CardPlayer, Difficulty, Variant } from "@friberg/card-link-core";
import { RULES } from "@friberg/card-link-core";
import Page from "../components/Page";
import CardLinkIcon from "../components/CardLinkIcon";
import { api, errMsg } from "../api/client";
import { useCardGame } from "../card-link/useCardGame";
import "../card-link/style.css";
import "../card-link/cards.css";
export default function CardLink() {
  const { t } = useTranslation(),
    tr = (k: string) => t(`card.${k}`);
  const [params, setParams] = useSearchParams(),
    id = params.get("game");
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  const { view, directory, error, connectionError, realtimeReady, retryConnection, busy, pending, send, reload, setError } =
    useCardGame(id);
  const [variant, setVariant] = useState<Variant>("unlimited"),
    [enabled, setEnabled] = useState<boolean | null>(null),
    [query, setQuery] = useState(""),
    [queued, setQueued] = useState(false),
    [loading, setLoading] = useState(false),
    [position, setPosition] = useState(0),
    [rankings, setRankings] = useState<{ username: string; rating: number }[]>(
      [],
    ),
    [resume, setResume] = useState<string | null>(null);
  const identity = useAuth(state => state.user?.id ?? null);
  const [sceneAccess, setSceneAccess] = useState<Record<string, boolean>>({});
  const queueTicket = useRef<string | null>(null);
  const playersById = useMemo(() => new Map(directory.map(player => [player.id, player])), [directory]);
  const motionRoot = useCardMotion(
    `${id}:${view?.round}`,
    `${view?.current?.board.join(",")}/${view?.current?.hand.join(",")}`,
  );
  const usable = !!view && view.id === id && view.status === 'playing' &&
    !view.players.find(p => p.id === view.me)?.retired &&
    (!['friend', 'ranked'].includes(view.scene) || realtimeReady !== false) &&
    !view.current?.locked && !busy && !pending && !loading;
  const cardDrag = useCardPointerDrag(`${id}:${view?.round}`, usable, (data, index) => {
    if (!view?.current) return;
    if (data.kind === 'board') {
      const board = [...view.current.board], from = board.indexOf(data.id);
      if (from < 0) return;
      board.splice(from, 1);
      board.splice(index > from ? index - 1 : index, 0, data.id);
      if (board.every((pid, i) => pid === view.current!.board[i])) return;
      void send({ type: 'reorder', board });
    } else void send({ type: 'play', playerId: data.id, index });
  });
  const operation = useRef(false);
  const run = async (fn: () => Promise<void>) => {
    if (operation.current) return;
    operation.current = true;
    setLoading(true);
    setError("");
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      operation.current = false;
      setLoading(false);
    }
  };
  const enter = (next: string) => {
    cardDrag.end();
    setQuery('');
    setPosition(0);
    setDismissedResult(null);
    setQueued(false);
    setParams({ game: next });
  };
  useEffect(() => {
    let alive = true;
    void api
      .get("/card-link/config")
      .then((r) => { if (alive) { setEnabled(r.data.enabled); setSceneAccess(r.data.scenes ?? {}); } })
      .catch((e) => { if (alive) setError(errMsg(e)); });
    return () => { alive = false; };
  }, []);
  useEffect(() => { setResume(null); setQueued(false); }, [identity]);
  useEffect(() => {
    if (id) return;
    let alive = true;
    void api
      .get("/card-link/active")
      .then((r) => {
        if (!alive) return;
        // Solo games have no multiplayer reservation. Keep the just-returned
        // solo ID while refreshing the authoritative room/queue reservation.
        setResume(previous => r.data.id ?? previous);
        queueTicket.current = r.data.ticket ?? null;
        setQueued(r.data.queued);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [id, identity]);
  useEffect(() => {
    setPosition(view?.current?.board.length ?? 0);
  }, [view?.round, view?.current?.board.length]);
  useEffect(() => {
    if (!queued || id) return;
    let alive = true;
    const ticket = queueTicket.current;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const r = ticket
          ? await api.post('/card-link/queue/heartbeat', { ticket })
          : await api.get('/card-link/active');
        if (!alive) return;
        if (r.data.id) { enter(r.data.id); return; }
        if (!r.data.queued) { setQueued(false); return; }
      } catch (e) {
        if (alive) setError(errMsg(e));
      }
      if (alive) timer = setTimeout(poll, 2000);
    };
    timer = setTimeout(poll, 2000);
    return () => {
      alive = false;
      clearTimeout(timer);
      if (ticket) void api.delete('/card-link/queue', { data: { ticket } }).catch(() => undefined);
    };
  }, [queued, id]);
  // Deadline recovery also covers a missed Socket notification; never submits an action.
  useEffect(() => {
    if (!view?.dueAt) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const recover = async () => {
      await reload().catch(() => undefined);
      if (alive) timer = setTimeout(recover, 2000);
    };
    timer = setTimeout(recover, Math.max(0, view.dueAt - Date.now()) + 1200);
    return () => { alive = false; clearTimeout(timer); };
  }, [view?.dueAt, reload]);
  const find = (pid: number) => playersById.get(pid);
  const label = (pid: number) => find(pid)?.nickname ?? String(pid);
  const menu = params.get("menu");
  const lobbyScene = lobbyScenes.includes(menu as LobbyScene) ? menu as LobbyScene : null;
  const start = (scene: "practice" | "daily" | "friend", difficulty: Difficulty, duration: number) =>
    run(async () => {
      const r = await api.post("/card-link/matches", {
        scene,
        variant,
        difficulty,
        duration,
        requestId: crypto.randomUUID(),
      });
      enter(r.data.id);
    });
  const control = (action: string) =>
    run(async () => {
      await api.post(`/card-link/matches/${id}/control`, {
        action,
        requestId: crypto.randomUUID(),
      });
      if (action === "leave") {
        setParams({});
        setResume(null);
      } else await reload();
    });
  const restart = () => {
    if (!view || view.status !== 'finished' || !['practice', 'daily'].includes(view.scene)) return;
    void run(async () => {
      const response = await api.post('/card-link/matches', {
        scene: view.scene, variant: view.variant, difficulty: view.difficulty,
        duration: view.duration, requestId: crypto.randomUUID(),
      });
      enter(response.data.id);
    });
  };
  const chain = view?.current && view.question ? [view.question.start, ...view.current.board, view.question.end] : [];
  const resultKey = view ? `${view.id}:${view.round}` : '';
  const resultReady = !!view?.current && ['roundOver', 'finished'].includes(view.status);
  const backToLobby = () => {
    if (!view) return;
    setVariant(view.variant);
    setResume(['finished', 'cancelled'].includes(view.status) ? null : view.id);
    setParams({ menu: view.scene });
  };
  const card = (
    pid: number,
    kind: "fixed" | "board" | "hand" | "search",
    index = 0,
  ) => {
    const p = find(pid);
    return (
      <article
        className={`cl-card cl-card-${kind}`}
        key={`${kind}:${pid}`}
        data-cl-card={pid}
        data-cl-area={kind}
        draggable={false}
        data-cl-draggable={usable && kind !== 'fixed' ? '' : undefined}
        data-cl-drop-index={kind === 'fixed' ? (pid === view?.question?.start ? 0 : view?.current?.board.length) : undefined}
        onDragStart={e => e.preventDefault()}
        onPointerDown={e => { if (kind !== 'fixed') cardDrag.start(e, { id: pid, kind }); }}
      >
        <PlayerCardFace player={p} id={pid} variant={view?.variant} />
        {kind === "board" && (
          <div className="cl-card-actions">
            <button
              disabled={!usable || index === 0}
              aria-label={tr("left")}
              onClick={() => {
                const board = [...view!.current!.board];
                [board[index - 1], board[index]] = [
                  board[index],
                  board[index - 1],
                ];
                void send({ type: "reorder", board });
              }}
            >
              ←
            </button>
            <button
              disabled={!usable}
              aria-label={tr("remove")}
              onClick={() => void send({ type: "remove", playerId: pid })}
            >
              ×
            </button>
            <button
              disabled={!usable || index === view!.current!.board.length - 1}
              aria-label={tr("right")}
              onClick={() => {
                const board = [...view!.current!.board];
                [board[index + 1], board[index]] = [
                  board[index],
                  board[index + 1],
                ];
                void send({ type: "reorder", board });
              }}
            >
              →
            </button>
          </div>
        )}
        {(kind === "hand" || kind === "search") && <div className="cl-hand-actions">
          <button
            className="btn btn-sm"
            disabled={!usable}
            onClick={() =>
              void send({ type: "play", playerId: pid, index: position })
            }
          >
            ＋
          </button>
        {kind === "hand" && (
          <button
            className="btn btn-ghost btn-sm"
            aria-label={tr("swap")}
            disabled={!usable || !view!.current!.token}
            onClick={() => void send({ type: "swap", playerId: pid })}
          >
            {tr("swapShort")}
          </button>
        )}
        </div>}
      </article>
    );
  };
  return (
    <Page
      title={tr("title")}
      icon={<CardLinkIcon size={20} />}
      className={`cl-page${view?.current ? ' cl-game-page' : ''}`}
    >
      <div ref={motionRoot}>
        <div className="cl-intro">
        <p className="cl-description">{tr("description")}</p>
        <details className="cl-rules">
          <summary>{tr("rules")}</summary>
          <p>{tr("instructions")}</p>
          <DifficultyRules />
          <p>{tr("notice")}</p>
        </details>
        </div>
        {error && (
          <p role="alert" className="cl-error">
            {error}
          </p>
        )}
        {pending && (
          <button className="btn" disabled={busy} onClick={() => void send()}>
            {tr("retry")}
          </button>
        )}
        {connectionError && <p role="alert">{tr('syncFailed')} {connectionError}{' '}
          <button className="btn" onClick={retryConnection}>{tr('retry')}</button>
        </p>}
        {!connectionError && realtimeReady === false && view && ['friend', 'ranked'].includes(view.scene) &&
          !['finished', 'cancelled'].includes(view.status) && <p role="status">{tr('reconnecting')}</p>}
        {!id && (
          <>
            {enabled === false && <p role="status">{tr("unavailable")}</p>}
            {lobbyScene && sceneAccess[lobbyScene] === false && <p role="status">{tr('scenePaused')}</p>}
            {resume && (
              <button className="btn" onClick={() => enter(resume)}>
                {tr("resume")}
              </button>
            )}
            <div className={lobbyScene === 'daily' ? 'daily-content-layout has-leaderboard cl-daily-layout' : undefined}>
            <CardLobby scene={lobbyScene}
              navigate={scene => setParams(scene ? { menu: scene } : {})}
              variant={variant} setVariant={setVariant}
              disabled={!enabled || loading || queued || (!!lobbyScene && sceneAccess[lobbyScene] === false)} loading={loading || queued}
              start={start}
              join={code => void run(async () => {
                const r = await api.post('/card-link/join', { code });
                enter(r.data.id);
              })}
              queue={() => void run(async () => {
                const r = await api.post('/card-link/queue', { variant });
                queueTicket.current = r.data.ticket ?? null;
                if (r.data.id) enter(r.data.id);
                else setQueued(true);
              })}
            />
            {lobbyScene === 'daily' && <CardDailyLeaderboard key={`${variant}:${identity}`} variant={variant} />}
            </div>
            {queued && (
              <p role="status">
                {tr("queued")}{" "}
                <button
                  className="btn"
                  onClick={() =>
                    run(async () => {
                      const r = await api.delete("/card-link/queue", { data: { ticket: queueTicket.current ?? undefined } });
                      if (r.data.id) enter(r.data.id);
                      else setQueued(false);
                    })
                  }
                >
                  {tr("cancel")}
                </button>
              </p>
            )}
            <div className="cl-toolbar">
              <Link className="btn btn-ghost" to="/stats?variant=card-link">{tr("history")}</Link>
              <button
                className="btn btn-ghost"
                onClick={() =>
                  run(async () =>
                    setRankings(
                      (
                        await api.get("/card-link/leaderboard", {
                          params: { variant },
                        })
                      ).data,
                    ),
                  )
                }
              >
                {tr("leaderboard")}
              </button>
              {lobbyScene !== 'daily' && <button
                className="btn btn-ghost"
                onClick={() => setParams({ menu: 'daily' })}
              >
                {tr("dailyLeaderboard")}
              </button>}
            </div>
            {rankings.map((r, i) => (
              <p key={r.username}>
                {i + 1}. {r.username} — {r.rating}
              </p>
            ))}
          </>
        )}
        {id && !view && <p role="status">…</p>}
        {view && (
          <>
            {view.scene === 'daily' && <p role="status" className="muted cl-daily-notice">
              {tr(['finished', 'cancelled'].includes(view.status) ? 'dailyFinishedNotice' :
                view.dailyPractice ? 'dailyPracticeNotice' : 'dailyOfficialNotice')}
            </p>}
            <div className="cl-match-header">
            <div className="cl-toolbar">
              <span>
                {tr(view.variant)} · {tr("round")} {view.round + 1}/
                {view.rounds} · {tr(view.status)}
              </span>
              {view.code && <strong>{view.code}</strong>}
              <MatchClock view={view} />
              <button className="btn btn-ghost" onClick={backToLobby}>
                {tr("back")}
              </button>
              <button
                className="btn btn-ghost"
                disabled={loading}
                onClick={() => control("leave")}
              >
                {tr("leave")}
              </button>
              {resultReady && <button className="btn" onClick={() => setDismissedResult(null)}>{tr('roundResult')}</button>}
            </div>
            <div className="cl-players">
              {view.players.map((p) => (
                <span key={p.id}>
                  {p.id === view.me ? "● " : ""}
                  {p.name}{" "}
                  {!p.retired && p.connected === false && p.disconnectAt != null && !['finished', 'cancelled'].includes(view.status) && <ConnectionStatus deadline={p.disconnectAt} />}
                  {p.retired
                    ? "×"
                    : view.status === "waiting"
                      ? p.ready
                        ? "✓"
                        : "…"
                      : p.solved
                        ? "✓"
                        : "…"}
                </span>
              ))}
            </div>
            </div>
            {view.status === "waiting" && (
              <div className="cl-toolbar">
                {view.scene === 'ranked' && <span role="status">{tr('readyCheck')}</span>}
                <button
                  className="btn"
                  disabled={loading || realtimeReady === false}
                  onClick={() => control("ready")}
                >
                  {tr("ready")}
                </button>
                {view.host && view.scene !== 'ranked' && (
                  <button
                    className="btn"
                    disabled={loading}
                    onClick={() => control("start")}
                  >
                    {tr("start")}
                  </button>
                )}
              </div>
            )}
            {view.current && view.question && (
              <>
                <div className="cl-toolbar">
                  <span>
                    {tr("best")}:{" "}
                    {view.current.best
                      ? `${view.current.best.path.length - 1} ${tr("hops")} · ${(view.current.best.elapsed / 1000).toFixed(1)}s`
                      : tr("unknown")}
                  </span>
                  {view.variant === "limited" && (
                    <>
                      <span>
                        {tr("token")}: {view.current.token}/{RULES.maxTokens}
                      </span>
                      <span data-cl-deck>
                        {tr("remaining")}: {view.current.remaining}
                      </span>
                      <button
                        className="btn"
                        disabled={!usable || !view.current.token}
                        onClick={() => void send({ type: "refresh" })}
                      >
                        {tr("refresh")}
                      </button>
                    </>
                  )}
                  <button
                    className="btn"
                    disabled={!usable}
                    onClick={() => void send({ type: "lock" })}
                  >
                    {tr("lock")}
                  </button>
                  <label className="cl-insert-control">
                    {tr("insert")}
                    <select value={position} onChange={(e) => setPosition(Number(e.target.value))}>
                      {Array.from({ length: view.current.board.length + 1 }, (_, i) => (
                        <option key={i} value={i}>{i + 1}</option>
                      ))}
                    </select>
                  </label>
                </div>
                <div className="cl-board">
                  {card(view.question.start, "fixed")}
                  {Array.from(
                    { length: view.current.board.length + 1 },
                    (_, i) => (
                      <div className="cl-slot-group" key={chain[i + 1]} data-cl-drop-index={i}>
                        <ConnectionSlot
                          first={label(chain[i])}
                          second={label(chain[i + 1])}
                          evidence={view.connections?.find(e => e.a === Math.min(chain[i], chain[i + 1]) && e.b === Math.max(chain[i], chain[i + 1]))?.evidence ?? []}
                          className={`cl-slot ${view.current!.links[i] ? "cl-linked" : ""} ${position === i ? "cl-selected" : ""}`}
                          aria-label={`${tr("insert")} ${i + 1}`}
                          onClick={() => setPosition(i)}

                        >
                          {view.current!.links[i] ? "✓" : "＋"}
                        </ConnectionSlot>
                        {i < view.current!.board.length &&
                          card(view.current!.board[i], "board", i)}
                      </div>
                    ),
                  )}
                  {card(view.question.end, "fixed")}
                </div>
                {view.current.exhausted && (
                  <p role="status" className="cl-recovery-notice">{tr("exhausted")}</p>
                )}
                {view.variant === 'limited' && view.current.refreshes > 0 && !view.current.exhausted &&
                  <p role="status" className="cl-recovery-notice">{t('card.autoRecoveryNotice', { count: view.current.refreshes })}</p>}
                {view.variant === "limited" ? (
                  <>
                    <div className="cl-hand">
                      {view.current.hand.map((pid) => card(pid, "hand"))}
                    </div>
                    <details>
                      <summary data-cl-discard>
                        {tr("discarded")} ({view.current.discarded.length}) ·{" "}
                        {tr("auto")} {view.current.refreshes}
                      </summary>
                      <p>{view.current.discarded.map(label).join(", ")}</p>
                    </details>
                  </>
                ) : (
                  <>
                    <input
                      className="cl-search"
                      placeholder={tr("search")}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <div className="cl-hand">
                      {query &&
                        directory
                          .filter(
                            (p) =>
                              p.id !== view.question!.start &&
                              p.id !== view.question!.end &&
                              !view.current!.board.includes(p.id) &&
                              [p.nickname, ...p.aliases].some((n) =>
                                n.toLowerCase().includes(query.toLowerCase()),
                              ),
                          )
                          .slice(0, 20)
                          .map((p) => card(p.id, "search"))}
                    </div>
                  </>
                )}
              </>
            )}
            {view.solution && (
              <details className="cl-results">
                <summary>{tr("solution")} · {tr("evidence")}</summary>
                <SolutionRoute path={view.solution} evidence={view.evidence} label={label} />
                {view.players.map((p) => (
                  <p key={p.id}>
                    {p.name}:{" "}
                    {p.results[view.round]?.path.map(label).join(" → ") ??
                      tr("unknown")}
                  </p>
                ))}
                <h3>{tr("evidence")}</h3>
                {view.evidence.map((e) => (
                  <div key={`${e.a}:${e.b}`}>
                    <strong>
                      {label(e.a)} ↔ {label(e.b)}
                    </strong>
                    {e.evidence.map((r, i) => (
                      <p key={i}>
                        {r.team} · {r.start} – {r.end}{" "}
                        {r.sources.map((url) => (
                          <a
                            href={url}
                            key={url}
                            target="_blank"
                            rel="noreferrer"
                          >
                            {tr("source")} ↗{" "}
                          </a>
                        ))}
                      </p>
                    ))}
                  </div>
                ))}
              </details>
            )}
          </>
        )}
      </div>
      {view && resultReady && dismissedResult !== resultKey && <RoundResult key={resultKey}
        view={view} directory={directory} close={() => setDismissedResult(resultKey)} back={backToLobby}
        restart={view.status === 'finished' && ['practice', 'daily'].includes(view.scene) ? restart : undefined}
        busy={loading} error={error} />}
    </Page>
  );
}
