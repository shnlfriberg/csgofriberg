import { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import type { PlayerPerformanceStats } from '../types';
import ModalPortal from './ModalPortal';
import PlayerStatsSummary from './PlayerStatsSummary';

export interface PlayerStatsView {
  displayId: string;
  stats: PlayerPerformanceStats;
}

export default function PlayerStatsDialog({ view, onClose }: { view: PlayerStatsView; onClose: () => void }) {
  const { t } = useTranslation();
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus();
    };
  }, [onClose]);

  return (
    <ModalPortal>
      <div className="replay-backdrop player-stats-backdrop" onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}>
        <div className="replay-dialog player-stats-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className="replay-heading">
            <div>
              <h2 id={titleId}>{t('multi.playerStats')}</h2>
              <p>{view.displayId}</p>
            </div>
            <button ref={closeRef} className="confirm-close" type="button" aria-label={t('multi.closeStats')} onClick={onClose}>
              <X size={18} />
            </button>
          </div>
          <div className="replay-dialog-body player-stats-dialog-body">
            <PlayerStatsSummary stats={view.stats} />
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
