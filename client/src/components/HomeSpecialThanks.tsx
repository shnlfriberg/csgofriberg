import { useEffect, useId, useRef, useState } from 'react';
import { HeartHandshake, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { SPECIAL_THANKS } from '../config/specialThanks';
import ModalPortal from './ModalPortal';

export default function HomeSpecialThanks() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    if (!open) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKeyDown);
      triggerRef.current?.focus();
    };
  }, [open]);

  if (!SPECIAL_THANKS.length) return null;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-special-thanks"
        onClick={() => setOpen(true)}
      >
        <HeartHandshake size={18} />
        {t('home.specialThanks')}
      </button>
      {open && (
        <ModalPortal>
          <div
            className="thanks-dialog-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setOpen(false);
            }}
          >
            <section
              className="thanks-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
            >
              <header className="thanks-dialog-heading">
                <h2 id={titleId}>
                  <HeartHandshake size={20} />
                  {t('home.specialThanks')}
                </h2>
                <button
                  ref={closeButtonRef}
                  type="button"
                  className="confirm-close"
                  aria-label={t('home.closeSpecialThanks')}
                  onClick={() => setOpen(false)}
                >
                  <X size={18} />
                </button>
              </header>
              <ul className="thanks-dialog-list">
                {SPECIAL_THANKS.map((item) => (
                  <li key={item.name}>
                    <a
                      href={item.href}
                      target="_blank"
                      rel="noopener noreferrer"
                      data-umami-event={item.analyticsEvent}
                    >
                      <img className="thanks-dialog-avatar" src={item.image} alt={item.name} />
                      <div className="thanks-dialog-copy">
                        <strong>{item.name}</strong>
                        {item.note && <p>{item.note}</p>}
                      </div>
                    </a>
                  </li>
                ))}
              </ul>
            </section>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
