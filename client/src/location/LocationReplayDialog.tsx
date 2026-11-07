import { useEffect, useId, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../i18n';
import { RoundReview } from './Components';
import type { LocationReplayItem, ReplayRecord } from './types';

export default function LocationReplayDialog({ replay, item, onClose }: {
  replay: ReplayRecord; item: LocationReplayItem; onClose: () => void;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  const [round, setRound] = useState(0);
  const [player, setPlayer] = useState(replay.myKey || replay.owner.key);
  const selected = replay.roomResults?.find((result) => result.key === player) || replay.roomResults?.[0];
  const rounds = selected?.rounds || replay.results;
  const total = selected ? rounds.reduce((sum, result) => sum + result.score, 0) : replay.totalScore;
  const playerName = selected && selected.key !== (replay.myKey || replay.owner.key) ? selected.name : undefined;
  useEffect(() => {
    dialog.current?.showModal();
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = oldOverflow; };
  }, []);
  return <dialog ref={dialog} className="replay-dialog location-replay-dialog location-page"
    onClick={(event) => {
      if (event.target !== dialog.current) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) onClose();
    }}
    aria-labelledby={titleId} onCancel={(event) => {
      if (event.target !== dialog.current) return;
      event.preventDefault(); onClose();
    }} onKeyDown={(event) => {
      if (!rounds.length || (event.target as HTMLElement).closest('dialog') !== dialog.current ||
        ['INPUT', 'SELECT', 'TEXTAREA'].includes((event.target as HTMLElement).tagName)) return;
      if (event.key === 'ArrowLeft') { event.preventDefault(); setRound((n) => Math.max(0, n - 1)); }
      if (event.key === 'ArrowRight') { event.preventDefault(); setRound((n) => Math.min(rounds.length - 1, n + 1)); }
    }}>
    <header className="replay-heading">
      <div>
        <h2 id={titleId}>{t('location.replayTitle')}</h2>
        <p>{t(`location.${item.mode}`)} · {t(`location.${item.difficulty}`)} · {total.toLocaleString()} / {(25000).toLocaleString()}</p>
        <p>{new Date(item.finishedAt).toLocaleString(currentLocale())}</p>
      </div>
      <button type="button" className="confirm-close" aria-label={t('replay.close')} onClick={onClose}><X size={18} /></button>
    </header>
    <div className="replay-dialog-body">
      {replay.roomResults && <label className="location-replay-player">
        {t('location.playerPins')}
        <select className="input" value={selected?.key || ''} onChange={(event) => { setPlayer(event.target.value); setRound(0); }}>
          {replay.roomResults.map((result) => <option key={result.key} value={result.key}>
            {result.name}{result.key === (replay.myKey || replay.owner.key) ? ` · ${t('common.me')}` : ''}
          </option>)}
        </select>
      </label>}
      {rounds.length ? <>
        <nav className="location-replay-thumbnails" aria-label={t('replay.pagination')}>
          {rounds.map((result, index) => <button key={result.round} type="button"
            aria-label={t('replay.round', { round: result.round })} aria-pressed={round === index}
            className={round === index ? 'selected' : ''} onClick={() => setRound(index)}>
            <img src={result.imageUrl} alt="" loading="lazy" />
            <span>{t('location.round', { round: result.round })} · {result.score.toLocaleString()}</span>
          </button>)}
        </nav>
        <div className="stats-pagination">
          <button className="btn btn-ghost" type="button" aria-label={t('replay.previousRound')}
            disabled={round === 0} onClick={() => setRound((n) => n - 1)}><ChevronLeft size={17} /></button>
          <span>{t('replay.roundPage', { current: round + 1, total: rounds.length })}</span>
          <button className="btn btn-ghost" type="button" aria-label={t('replay.nextRound')}
            disabled={round >= rounds.length - 1} onClick={() => setRound((n) => n + 1)}><ChevronRight size={17} /></button>
        </div>
        <RoundReview key={`${player}:${round}`} result={rounds[round]} playerName={playerName} />
      </> : <p className="muted">{t('replay.noRounds')}</p>}
    </div>
  </dialog>;
}
