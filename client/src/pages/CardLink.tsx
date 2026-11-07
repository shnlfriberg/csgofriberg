import CardLobby, { lobbySceneFrom } from '../card-link/Lobby';
import { useCardMotion } from "../card-link/useCardMotion";
import { useCardPointerDrag } from "../card-link/useCardPointerDrag";
import ConnectionSlot from "../card-link/ConnectionSlot";
import SolutionRoute from "../card-link/SolutionRoute";
import GameRules from "../components/GameRules";
import PlayerCardFace from "../card-link/PlayerCardFace";
import MatchClock from '../card-link/MatchClock';
import ConnectionStatus from '../card-link/ConnectionStatus';
import RoundResult from '../card-link/RoundResult';
import CardDailyLeaderboard from '../card-link/DailyLeaderboard';
import { useAuth } from '../store/auth';
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { ArrowLeft } from "lucide-react";
import type { CardPlayer, Difficulty, Variant } from "@friberg/card-link-core";
import { RULES } from "@friberg/card-link-core";
import Page from "../components/Page";
import CardLinkIcon from "../components/CardLinkIcon";
import { api, errMsg } from "../api/client";
import { getSocket } from "../api/socket";
import { occupiedOf } from "../api/roomKernel";
import { useOccupiedRoomPrompt } from "../components/OccupiedRoomDialog";
import { useConfirm } from "../components/ConfirmDialog";

const QUEUE_HEARTBEAT_MS = 5_000;
/** Menu titles per scene; ranked matches live on the multiplayer page. */
const SCENE_TITLES: Record<string, string> = { practice: 'practice', daily: 'daily', friend: 'multiplayer', ranked: 'multiplayer' };
/** Stable empty prop: a fresh [] would re-run the connection tooltip's effects on every render. */
const NO_EVIDENCE: never[] = [];
import { useCardGame } from "../card-link/useCardGame";
import "../card-link/style.css";
import "../card-link/cards.css";
export default function CardLink() {
  const { t } = useTranslation(),
    tr = (k: string) => t(`card.${k}`);
  const [params, setParams] = useSearchParams();
  // 单人 (practice) matches open as ?solo=<id> and run on the shared
  // single-player API; daily and multiplayer matches open as ?game=<id>.
  const soloId = params.get("solo"),
    id = params.get("game") ?? soloId;
  const [dismissedResult, setDismissedResult] = useState<string | null>(null);
  const { view, directory, error, connectionError, realtimeReady, retryConnection, busy, pending, send, reload, setError } =
    useCardGame(id, Boolean(soloId));
  const [occupiedDialog, promptOccupied] = useOccupiedRoomPrompt();
  const confirm = useConfirm();
  const [variant, setVariant] = useState<Variant>("unlimited"),
    [enabled, setEnabled] = useState<boolean | null>(null),
    [query, setQuery] = useState(""),
    [queued, setQueued] = useState(false),
    [loading, setLoading] = useState(false),
    [position, setPosition] = useState(0),
    [rankings, setRankings] = useState<{ username: string; rating: number }[]>(
      [],
    ),
    [resume, setResume] = useState<{ id: string; solo: boolean } | null>(null);
  const identity = useAuth(state => state.user?.id ?? null);
  // Random matchmaking needs a signed-in account with a verified email (checked again by the server).
  const authReady = useAuth(state => state.initialized);
  const matchAllowed = useAuth(state => state.initialized && Boolean(state.user?.id && state.user.email && state.user.emailVerified));
  const [sceneAccess, setSceneAccess] = useState<Record<string, boolean>>({});
  const queueTicket = useRef<string | null>(null);
  const playersById = useMemo(() => new Map(directory.map(player => [player.id, player])), [directory]);
  // Pre-normalised names, filtered with a deferred query: typing and room
  // patches never re-scan and lowercase the whole directory on every render.
  const searchIndex = useMemo(() => directory.map(player => ({
    id: player.id,
    names: [player.nickname, ...player.aliases].map(name => name.toLowerCase()),
  })), [directory]);
  const deferredQuery = useDeferredValue(query.trim().toLowerCase());
  const searchStart = view?.question?.start, searchEnd = view?.question?.end, searchBoard = view?.current?.board;
  const searchResults = useMemo(() => {
    if (!deferredQuery || searchStart === undefined) return [];
    const onBoard = new Set(searchBoard ?? []);
    const found: number[] = [];
    for (const entry of searchIndex) {
      if (entry.id === searchStart || entry.id === searchEnd || onBoard.has(entry.id)) continue;
      if (!entry.names.some(name => name.includes(deferredQuery))) continue;
      found.push(entry.id);
      if (found.length === 20) break;
    }
    return found;
  }, [deferredQuery, searchIndex, searchStart, searchEnd, searchBoard]);
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
  const run = async (fn: () => Promise<void>, retryAfterLeaving = false): Promise<void> => {
    if (operation.current) return;
    operation.current = true;
    setLoading(true);
    setError("");
    let retry = false;
    try {
      await fn();
    } catch (e) {
      // Seated in a classic or 图寻 room: offer to return there or leave it first.
      const occupied = occupiedOf(e);
      if (occupied && retryAfterLeaving) retry = (await promptOccupied(occupied)) === 'left';
      else setError(errMsg(e));
    } finally {
      operation.current = false;
      setLoading(false);
    }
    if (retry) await run(fn);
  };
  const viewRef = useRef(view);
  viewRef.current = view;
  const enter = (next: string, solo = false) => {
    cardDrag.end();
    setQuery('');
    setPosition(0);
    setDismissedResult(null);
    setQueued(false);
    setParams(solo ? { solo: next } : { game: next });
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
        // A room reservation comes first; otherwise the server's current 单人
        // match (any device or tab). Keep a just-left daily match ID as well.
        setResume(previous => r.data.id ? { id: r.data.id, solo: false } : previous);
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
    // The pairing is pushed to this identity; the heartbeat only keeps the lease.
    const socket = getSocket();
    const found = (event: { game?: string; roomId?: string }) => {
      if (alive && event?.game === 'card-link' && event.roomId) enter(event.roomId);
    };
    socket.on('room-kernel:found', found);
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
      if (alive) timer = setTimeout(poll, QUEUE_HEARTBEAT_MS);
    };
    timer = setTimeout(poll, QUEUE_HEARTBEAT_MS);
    return () => {
      alive = false;
      socket.off('room-kernel:found', found);
      clearTimeout(timer);
      if (ticket) void api.delete('/card-link/queue', { data: { ticket } }).catch(() => undefined);
    };
  }, [queued, id]);
  // Deadline recovery covers a missed Socket notification; never submits an action.
  // With a live subscription the server pushes the transition, so only one late
  // fallback read is made; polling continues only while realtime is down.
  const realtimeLive = realtimeReady !== false;
  useEffect(() => {
    if (!view?.dueAt) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    const recover = async () => {
      await reload().catch(() => undefined);
      if (alive && !realtimeLive) timer = setTimeout(recover, 2000);
    };
    timer = setTimeout(recover, Math.max(0, view.dueAt - Date.now()) + (realtimeLive ? 5000 : 1200));
    return () => { alive = false; clearTimeout(timer); };
  }, [view?.dueAt, reload, realtimeLive]);
  const find = (pid: number) => playersById.get(pid);
  const label = (pid: number) => find(pid)?.nickname ?? String(pid);
  const menu = params.get("menu");
  const lobbyScene = lobbySceneFrom(menu);
  /** Scene named in the title: the open menu, or the scene of the current match. */
  const pageScene = id ? view?.scene ?? null : lobbyScene;
  /** Like classic games: create or resume the 单人 match for this difficulty and hand mode. */
  const startSolo = async (hand: Variant, difficulty: Difficulty, duration: number) => {
    const r = await api.post('/game/start', { variant: 'card-link', mode: difficulty, hand, duration });
    enter(r.data.gameId, true);
  };
  const start = (scene: "practice" | "daily" | "friend", difficulty: Difficulty, duration: number) =>
    run(async () => {
      if (scene === 'practice') return startSolo(variant, difficulty, duration);
      const r = await api.post("/card-link/matches", {
        scene,
        variant,
        difficulty,
        duration,
        requestId: crypto.randomUUID(),
      });
      enter(r.data.id);
    }, scene === 'friend');
  const control = (action: string) =>
    run(async () => {
      if (soloId && action === 'leave') await api.post(`/game/${soloId}/exit`);
      else await api.post(`/card-link/matches/${id}/control`, {
        action,
        requestId: crypto.randomUUID(),
      });
      if (action === "leave") {
        setParams({});
        setResume(null);
        return;
      }
      // The change is pushed to every seat; read only if no push arrived in time.
      const before = viewRef.current;
      const signature = (v: typeof before) => v ? `${v.phaseRevision}:${v.publicRevision}:${v.revision}` : '';
      const expected = signature(before);
      setTimeout(() => {
        if (signature(viewRef.current) === expected) void reload().catch(() => undefined);
      }, 1500);
    });
  const restart = () => {
    if (!view || view.status !== 'finished' || !['practice', 'daily'].includes(view.scene)) return;
    void run(async () => {
      if (view.scene === 'practice') return startSolo(view.variant, view.difficulty, view.duration);
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
    setResume(['finished', 'cancelled'].includes(view.status) ? null : { id: view.id, solo: view.scene === 'practice' });
    // Ranked matches belong to the multiplayer page together with friend rooms.
    setParams({ menu: view.scene === 'ranked' ? 'friend' : view.scene });
  };
  const cancelQueue = () => void run(async () => {
    const r = await api.delete("/card-link/queue", { data: { ticket: queueTicket.current ?? undefined } });
    if (r.data.id) enter(r.data.id);
    else setQueued(false);
  });
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
            aria-label={tr("playCard")}
            title={tr("playCard")}
            onClick={() =>
              void send({ type: "play", playerId: pid, index: position })
            }
          >
            <span aria-hidden="true">＋</span>
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
      title={pageScene ? `${tr("title")} · ${tr(SCENE_TITLES[pageScene])}` : tr("title")}
      icon={<CardLinkIcon size={20} />}
      className={`cl-page ent-page${view?.current ? ' cl-game-page' : ''}`}
      actions={
        // Back to the previous level always sits in the top bar, like the other modes.
        !id && !lobbyScene ? (
          <Link className="btn btn-ghost btn-sm" to="/entertainment">
            <ArrowLeft size={16} aria-hidden="true" />
            <span className="btn-text">{t('location.entertainment')}</span>
          </Link>
        ) : (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => (id && view ? backToLobby() : setParams({}))}>
            <ArrowLeft size={16} aria-hidden="true" />
            <span className="btn-text">{id && view ? tr("back") : tr("title")}</span>
          </button>
        )
      }
    >
      {occupiedDialog}
      <div ref={motionRoot}>
        {!id && !lobbyScene && <p className="muted single-lobby-subtitle">{tr("description")}</p>}
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
            {enabled === false && <p role="status" className="ent-notice">{tr("unavailable")}</p>}
            {resume && (
              <p className="ent-notice">
                <button className="btn" onClick={() => enter(resume.id, resume.solo)}>
                  {tr("resume")}
                </button>
              </p>
            )}
            <div className={lobbyScene === 'daily' ? 'daily-content-layout has-leaderboard cl-daily-layout' : undefined}>
            <CardLobby scene={lobbyScene}
              navigate={scene => setParams(scene ? { menu: scene } : {})}
              variant={variant} setVariant={setVariant}
              disabled={!enabled || loading} loading={loading}
              queued={queued} matchAllowed={matchAllowed} authReady={authReady} sceneAccess={sceneAccess}
              start={start}
              join={code => void run(async () => {
                const r = await api.post('/card-link/join', { code });
                enter(r.data.id);
              }, true)}
              queue={matchVariant => void run(async () => {
                const r = await api.post('/card-link/queue', { variant: matchVariant });
                queueTicket.current = r.data.ticket ?? null;
                if (r.data.id) enter(r.data.id);
                else setQueued(true);
              }, true)}
              cancelQueue={cancelQueue}
            />
            {lobbyScene === 'daily' && <CardDailyLeaderboard key={`${variant}:${identity}`} variant={variant} />}
            </div>
            {/* Outside the multiplayer page (whose match card shows it), keep the queue visible. */}
            {queued && lobbyScene !== 'friend' && (
              <p role="status" className="cl-queued-status">
                <span className="spinner matchmaking-spinner" aria-hidden="true" />
                {tr("queued")}{" "}
                <button className="btn btn-ghost btn-sm" onClick={() => setParams({ menu: 'friend' })}>{tr("multiplayer")}</button>
                <button className="btn btn-sm" onClick={cancelQueue}>{tr("cancel")}</button>
              </p>
            )}
            <div className="cl-toolbar cl-lobby-links">
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
            {rankings.length > 0 && (
              <section className="card cl-rankings" aria-labelledby="cl-rankings-heading">
                <div className="cl-rankings-heading">
                  <h3 id="cl-rankings-heading">{tr("leaderboard")}</h3>
                  <button className="btn btn-ghost btn-sm" type="button" onClick={() => setRankings([])}>{t('common.close')}</button>
                </div>
                <ol className="cl-rankings-list">
                  {rankings.map((r, i) => (
                    <li key={r.username}>
                      <span className="cl-rankings-rank">#{i + 1}</span>
                      <strong>{r.username}</strong>
                      <span className="cl-rankings-rating" title={tr("rating")}>{r.rating}</span>
                    </li>
                  ))}
                </ol>
              </section>
            )}
          </>
        )}
        {id && !view && <p role="status" className="page-loading"><span className="spinner" aria-hidden="true" />{t('common.loading')}</p>}
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
              <button
                className="btn btn-ghost"
                disabled={loading}
                onClick={() => void (async () => {
                  // Leaving retires this seat for the rest of the match: confirm first.
                  if (!['finished', 'cancelled'].includes(view.status) && !(await confirm({
                    title: tr("leave"),
                    message: tr("leaveConfirm"),
                    confirmLabel: tr("leave"),
                    tone: 'warning',
                  }))) return;
                  await control("leave");
                })()}
              >
                {tr("leave")}
              </button>
              {resultReady && <button className="btn" onClick={() => setDismissedResult(null)}>{tr('roundResult')}</button>}
            </div>
            <div className="cl-players">
              {view.players.map((p) => (
                <span key={p.id} className={p.id === view.me ? 'cl-player-me' : undefined}>
                  {p.id === view.me && <span aria-hidden="true">● </span>}
                  {p.name}{" "}
                  {p.id === view.me && <span className="sr-only">({tr("you")})</span>}
                  {!p.retired && p.connected === false && p.disconnectAt != null && !['finished', 'cancelled'].includes(view.status) && <ConnectionStatus deadline={p.disconnectAt} />}
                  {(() => {
                    // Glyphs stay as the compact visual; screen readers get the status text.
                    const [glyph, label] = p.retired
                      ? ["×", tr("statusRetired")]
                      : (view.status === "waiting" ? p.ready : p.solved)
                        ? ["✓", tr(view.status === "waiting" ? "statusReady" : "solved")]
                        : ["…", tr(view.status === "waiting" ? "statusNotReady" : "statusSolving")];
                    return <span title={label}><span aria-hidden="true">{glyph}</span><span className="sr-only">{label}</span></span>;
                  })()}
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
                          evidence={view.connections?.find(e => e.a === Math.min(chain[i], chain[i + 1]) && e.b === Math.max(chain[i], chain[i + 1]))?.evidence ?? NO_EVIDENCE}
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
                      className="cl-search input"
                      type="search"
                      aria-label={tr("search")}
                      placeholder={tr("search")}
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <div className="cl-hand">
                      {query && searchResults.map((pid) => card(pid, "search"))}
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
        <div className="cl-rules-entry"><GameRules variant="card-link" /></div>
      </div>
      {view && resultReady && dismissedResult !== resultKey && <RoundResult key={resultKey}
        view={view} directory={directory} close={() => setDismissedResult(resultKey)} back={backToLobby}
        restart={view.status === 'finished' && ['practice', 'daily'].includes(view.scene) ? restart : undefined}
        busy={loading} error={error} />}
    </Page>
  );
}
