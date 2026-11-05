import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { Trophy, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CardPlayer } from '@friberg/card-link-core';
import ModalPortal from '../components/ModalPortal';
import PlayerCardFace from './PlayerCardFace';
import ConnectionSlot from './ConnectionSlot';
import SolutionRoute from './SolutionRoute';
import type { View } from './types';

/** Native modal gives keyboard focus containment and restores focus on close. */
export default function RoundResult({ view, directory, close, back, restart, busy = false, error }: {
  view: View; directory: CardPlayer[]; close: () => void; back: () => void;
  restart?: () => void; busy?: boolean; error?: string;
}) {
  const { t } = useTranslation(), tr = (key: string) => t(`card.${key}`);
  const dialog = useRef<HTMLDialogElement>(null);
  const [selected, setSelected] = useState(view.me);
  const players = useMemo(() => new Map(directory.map(p => [p.id, p])), [directory]);
  const edges = useMemo(() => new Map(view.evidence.map(e => [`${Math.min(e.a, e.b)}:${Math.max(e.a, e.b)}`, e.evidence])), [view.evidence]);
  const player = view.players.find(p => p.id === selected) ?? view.players[0];
  const best = player?.results[view.round] ?? (player?.id === view.me ? view.current?.best : null);
  const path = best?.path ?? (view.question ? [view.question.start, view.question.end] : []);
  const label = (id: number) => players.get(id)?.nickname ?? String(id);
  useEffect(() => {
    const node = dialog.current;
    node?.showModal();
    return () => node?.close();
  }, []);
  return <ModalPortal><dialog ref={dialog}
    className={`overlay-card cl-result-dialog${best ? ' overlay-card-win' : ' overlay-card-lose'}`}
    aria-label={tr('roundResult')} onCancel={event => { event.preventDefault(); close(); }}>
    <header className="cl-result-heading">
      <div><Trophy size={24} aria-hidden="true" /><h2>{tr(view.status === 'finished' ? 'finished' : 'roundOver')}</h2></div>
      <button className="btn btn-ghost btn-sm" aria-label={t('common.close')} onClick={close}><X size={18} /></button>
    </header>
    <p className="muted">{tr(view.variant)} · {tr('round')} {view.round + 1} / {view.rounds}</p>
    {view.players.length > 1 && <label className="cl-insert-control">{tr('replayPlayer')}
      <select value={player?.id ?? ''} onChange={event => setSelected(event.target.value)}>
        {view.players.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
    </label>}
    <div className="cl-result-score" role="status">
      {best ? <><strong>{best.path.length - 1}<small>{tr('hops')}</small></strong>
        <span>{tr('resultTime')} <b>{(best.elapsed / 1000).toFixed(3)}</b> {tr('seconds')}</span></> : <strong>{tr('unknown')}</strong>}
    </div>
    <div className="cl-board cl-result-board" role="group" aria-label={tr('replayPath')} tabIndex={0}>
      {path.map((id, index) => <Fragment key={`${index}:${id}`}>
        {index > 0 && (best ? <ConnectionSlot className="cl-slot cl-linked"
          first={label(path[index - 1])} second={label(id)}
          evidence={edges.get(`${Math.min(path[index - 1], id)}:${Math.max(path[index - 1], id)}`) ?? []}
          aria-label={`${label(path[index - 1])} ↔ ${label(id)} · ${tr('evidence')}`}>✓</ConnectionSlot>
          : <span className="cl-replay-gap">…</span>)}
        <article className={`cl-card cl-card-${index === 0 || index === path.length - 1 ? 'fixed' : 'board'}`}>
          <PlayerCardFace player={players.get(id)} id={id} variant={view.variant} />
        </article>
      </Fragment>)}
    </div>
    <p className="muted cl-result-hint">{tr('replayConnections')}</p>
    {view.solution && <details className="cl-results"><summary>{tr('solution')}</summary>
      <SolutionRoute path={view.solution} evidence={view.evidence} label={label} />
    </details>}
    {view.scene === 'daily' && <p className="cl-result-hint">{tr('dailyFinishedNotice')}</p>}
    {view.status === 'roundOver' && <p className="cl-result-hint">{tr('nextRoundNotice')}</p>}
    <div className="btns">
      {restart && <button className="btn" disabled={busy} onClick={restart}>{tr('restart')}</button>}
      <button className="btn btn-ghost" onClick={close}>{tr('viewBoard')}</button>
      {view.status === 'finished' && <button className="btn" onClick={back}>{tr('back')}</button>}
    </div>
    {error && <p className="cl-error" role="alert">{error}</p>}
  </dialog></ModalPortal>;
}
