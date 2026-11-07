import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { DoorOpen, LogOut, Users, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import ModalPortal from './ModalPortal';
import { leaveOccupied, occupiedPath, type OccupancyRef } from '../api/roomKernel';
import { useAuth } from '../store/auth';

type Choice = 'left' | 'returned' | 'dismissed';

/**
 * "You are already in another multiplayer room" — shared by every room game.
 * Returns a dialog element to render and a prompt function: `left` means the
 * other seat was released and the caller may retry its action.
 */
export function useOccupiedRoomPrompt(): [ReactNode, (ref: OccupancyRef) => Promise<Choice>] {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const userId = useAuth((state) => state.user?.id ?? null);
  const [pending, setPending] = useState<{ ref: OccupancyRef; resolve: (choice: Choice) => void } | null>(null);
  const [leaving, setLeaving] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const messageId = useId();
  const returnButton = useRef<HTMLButtonElement>(null);

  const prompt = useCallback((ref: OccupancyRef) => new Promise<Choice>((resolve) => {
    setError('');
    setLeaving(false);
    setPending((old) => {
      old?.resolve('dismissed');
      return { ref, resolve };
    });
  }), []);

  const settle = useCallback((choice: Choice) => {
    setPending((current) => {
      current?.resolve(choice);
      return null;
    });
  }, []);

  useEffect(() => {
    if (!pending) return;
    returnButton.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !leaving) settle('dismissed');
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [pending, leaving, settle]);

  useEffect(() => () => setPending((current) => {
    current?.resolve('dismissed');
    return null;
  }), []);

  const element = pending ? (
    <ModalPortal>
      <div className="confirm-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !leaving) settle('dismissed'); }}>
        <div className="confirm-dialog warning occupied-dialog" role="alertdialog" aria-modal="true" aria-labelledby={titleId} aria-describedby={messageId}>
          <div className="confirm-icon" aria-hidden="true"><Users size={22} /></div>
          <div className="confirm-content">
            <div className="confirm-heading">
              <h2 id={titleId}>{t('roomKernel.occupiedTitle')}</h2>
              <button className="confirm-close" type="button" aria-label={t('common.close')} disabled={leaving} onClick={() => settle('dismissed')}>
                <X size={18} />
              </button>
            </div>
            <p id={messageId}>
              {t('roomKernel.occupiedMessage', {
                game: t(`roomKernel.games.${pending.ref.game}`),
                code: pending.ref.summary?.code ?? pending.ref.roomId.slice(0, 8),
                status: t(`roomKernel.status.${pending.ref.summary?.status ?? 'playing'}`, { defaultValue: pending.ref.summary?.status ?? '' }),
              })}
            </p>
            {error && <p className="error" role="alert">{error}</p>}
            <div className="confirm-actions">
              <button
                ref={returnButton}
                className="btn btn-ghost"
                type="button"
                disabled={leaving}
                onClick={() => {
                  const path = occupiedPath(pending.ref, userId);
                  settle('returned');
                  navigate(path);
                }}
              >
                <DoorOpen size={15} aria-hidden="true" />
                <span className="btn-text">{t('roomKernel.occupiedReturn')}</span>
              </button>
              <button
                className="btn btn-warning"
                type="button"
                disabled={leaving}
                onClick={() => {
                  setLeaving(true);
                  setError('');
                  void leaveOccupied(pending.ref)
                    .then(() => settle('left'))
                    .catch(() => {
                      setLeaving(false);
                      setError(t('roomKernel.occupiedLeaveFailed'));
                    });
                }}
              >
                <LogOut size={15} aria-hidden="true" />
                <span className="btn-text">{t(leaving ? 'roomKernel.occupiedLeaving' : 'roomKernel.occupiedLeave')}</span>
              </button>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  ) : null;

  return [element, prompt];
}
