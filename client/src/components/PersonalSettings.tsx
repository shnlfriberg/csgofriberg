import { Settings, Sparkles, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getMotionEnabled, setMotionEnabled, subscribeMotion } from '../store/motion';
import ModalPortal from './ModalPortal';

export default function PersonalSettings() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const motionEnabled = useSyncExternalStore(subscribeMotion, getMotionEnabled, () => true);
  const titleId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  }, []);

  useEffect(() => {
    if (!open) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        close();
        return;
      }
      if (event.key === 'Tab') {
        const focusable = dialogRef.current?.querySelectorAll<HTMLElement>(
          'button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex="-1"])'
        );
        if (!focusable?.length) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (event.shiftKey && document.activeElement === first) {
          event.preventDefault();
          last.focus();
        } else if (!event.shiftKey && document.activeElement === last) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, open]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-ghost btn-sm personal-settings-trigger"
        aria-label={t('settings.title')}
        title={t('settings.title')}
        onClick={() => setOpen(true)}
        data-umami-event="personal-settings-open"
      >
        <Settings size={15} />
        <span className="btn-text">{t('settings.title')}</span>
      </button>
      {open && (
        <ModalPortal>
          <div
            className="confirm-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) close();
            }}
          >
            <div
              ref={dialogRef}
              className="confirm-dialog settings-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
            >
              <div className="confirm-icon settings-dialog-icon" aria-hidden="true">
                <Settings size={22} />
              </div>
              <div className="confirm-content">
                <div className="confirm-heading">
                  <h2 id={titleId}>{t('settings.title')}</h2>
                  <button
                    ref={closeRef}
                    className="confirm-close"
                    type="button"
                    aria-label={t('common.close')}
                    onClick={close}
                  >
                    <X size={18} />
                  </button>
                </div>
                <label className="settings-option">
                  <span className="settings-option-label">
                    <Sparkles size={18} aria-hidden="true" />
                    {t('settings.motion')}
                  </span>
                  <input
                    className="settings-switch"
                    type="checkbox"
                    role="switch"
                    checked={motionEnabled}
                    aria-label={t('settings.motion')}
                    onChange={(event) => setMotionEnabled(event.target.checked)}
                  />
                </label>
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
