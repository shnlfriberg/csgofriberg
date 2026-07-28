import { useEffect, useId, useRef, useState } from 'react';
import { HeartHandshake, X } from 'lucide-react';
import { api } from '../api/client';
import { useTranslation } from 'react-i18next';
import ModalPortal from './ModalPortal';

interface SpecialThanksItem {
  id: number;
  name: string;
  note: string;
}

export default function HomeSpecialThanks() {
  const { t } = useTranslation();
  const [items, setItems] = useState<SpecialThanksItem[]>([]);
  const [open, setOpen] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  useEffect(() => {
    let cancelled = false;
    api.get<{ items: SpecialThanksItem[] }>('/special-thanks')
      .then((response) => {
        if (!cancelled) setItems(response.data.items);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, []);

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

  if (!items.length) return null;

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
                {items.map((item) => (
                  <li key={item.id}>
                    <strong>{item.name}</strong>
                    {item.note && <p>{item.note}</p>}
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
