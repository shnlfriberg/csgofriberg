import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { CardPlayer, EdgeEvidence, Variant } from '@friberg/card-link-core';
import ConnectionSlot from './ConnectionSlot';
import PlayerCardFace from './PlayerCardFace';
import './cards.css';

export type CardReplay = {
  match?: { questions: { start: number; end: number }[]; dailyPractice?: boolean; variant?: Variant };
  playersDirectory: CardPlayer[];
  players: { id: string; name: string; retired: boolean; results: ({ path: number[]; elapsed: number } | null)[] }[];
  evidence: { a: number; b: number; evidence: EdgeEvidence[] }[];
};
const edgeKey = (a: number, b: number) => `${Math.min(a, b)}:${Math.max(a, b)}`;
export default function CardReplayDialog({ replay, close }: { replay: CardReplay; close: () => void }) {
  const { t } = useTranslation(), tr = (key: string) => t(`card.${key}`);
  const dialog = useRef<HTMLDialogElement>(null);
  const [playerIndex, setPlayerIndex] = useState(0), [round, setRound] = useState(0);
  const players = useMemo(() => new Map(replay.playersDirectory.map(p => [p.id, p])), [replay]);
  const edges = useMemo(() => new Map(replay.evidence.map(e => [edgeKey(e.a, e.b), e.evidence])), [replay]);
  const player = replay.players[playerIndex], result = player?.results[round];
  const question = replay.match?.questions[round];
  const rounds = Math.max(1, replay.match?.questions.length ?? 0, ...replay.players.map(p => p.results.length));
  const path = result?.path ?? (question ? [question.start, question.end] : []);
  const label = (id: number) => players.get(id)?.nickname ?? String(id);
  useEffect(() => {
    dialog.current?.showModal();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, []);
  return <dialog ref={dialog} className="replay-dialog cl-replay-dialog" aria-label={tr('open')}
    onCancel={event => { event.preventDefault(); close(); }}>
    <header className="replay-heading"><div><h2>{tr('open')}</h2><p>{tr('replayHint')}</p></div>
      <button className="confirm-close" aria-label={t('replay.close')} onClick={close}><X size={18} /></button></header>
    <div className="replay-dialog-body">
      {replay.match?.dailyPractice && <p>{tr('dailyPracticeNotice')}</p>}
      <div className="cl-toolbar">
        {replay.players.length > 1 ? <label>{tr('replayPlayer')} <select value={playerIndex} onChange={e => setPlayerIndex(Number(e.target.value))}>
          {replay.players.map((p, index) => <option key={p.id} value={index}>{p.name}</option>)}
        </select></label> : <h3>{player?.name}</h3>}
        {rounds > 1 && <label>{tr('round')} <select value={round} onChange={e => setRound(Number(e.target.value))}>
          {Array.from({ length: rounds }, (_, index) => <option key={index} value={index}>{tr('round')} {index + 1}</option>)}
        </select></label>}
        {player?.retired && <span>{t('location.retired')}</span>}
      </div>
      <p>{tr('round')} {round + 1} / {rounds} · {result ? `${path.length - 1} ${tr('hops')} · ${(result.elapsed / 1000).toFixed(1)} ${tr('seconds')}` : tr('unknown')}</p>
      <div key={`${player?.id}:${round}`} className="cl-board cl-replay-board" role="group" aria-label={tr('replayPath')} tabIndex={0}>
        {path.map((id, index) => <Fragment key={`${index}:${id}`}>
          {index > 0 && (result ? <ConnectionSlot className="cl-slot cl-linked"
            first={label(path[index - 1])} second={label(id)} evidence={edges.get(edgeKey(path[index - 1], id)) ?? []}
            aria-label={`${label(path[index - 1])} ↔ ${label(id)} · ${tr('evidence')}`}>✓</ConnectionSlot>
            : <span className="cl-replay-gap">…</span>)}
          <article className={`cl-card cl-card-${index === 0 || index === path.length - 1 ? 'fixed' : 'board'}`} aria-label={label(id)}>
            <PlayerCardFace player={players.get(id)} id={id} variant={replay.match?.variant} />
          </article>
        </Fragment>)}
        {!path.length && <p>{tr('unknown')}</p>}
      </div>
      <p className="muted">{tr('replayConnections')}</p>
    </div>
  </dialog>;
}
