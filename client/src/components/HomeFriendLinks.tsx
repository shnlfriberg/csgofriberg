import { useEffect, useId, useRef, useState } from 'react';
import { Link2, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { FRIEND_LINKS, type FriendLink } from '../config/friendLinks';
import ModalPortal from './ModalPortal';

export default function HomeFriendLinks({ links = FRIEND_LINKS }: { links?: readonly FriendLink[] }) {
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

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="btn btn-accent"
        onClick={() => setOpen(true)}
        data-umami-event="home-friend-links-open"
      >
        <Link2 size={17} />
        {t('home.friendLinks')}
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
              className="thanks-dialog friend-links-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
            >
              <header className="thanks-dialog-heading friend-links-dialog-heading">
                <h2 id={titleId}>
                  <Link2 size={20} />
                  {t('home.friendLinks')}
                </h2>
                <button
                  ref={closeButtonRef}
                  type="button"
                  className="confirm-close"
                  aria-label={t('home.closeFriendLinks')}
                  onClick={() => setOpen(false)}
                >
                  <X size={18} />
                </button>
              </header>
              {links.length ? (
                <ul className="friend-links-dialog-list">
                  {links.map((item) => (
                    <li key={`${item.name}:${item.href}`}>
                      <a
                        href={item.href}
                        target="_blank"
                        rel="noopener noreferrer"
                        data-umami-event="home-friend-link"
                        data-umami-event-name={item.name}
                      >
                        <span className="friend-links-dialog-icon" aria-hidden="true"><Link2 size={18} /></span>
                        <span>
                          <strong>{item.name}</strong>
                          <small>{item.description}</small>
                        </span>
                      </a>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="friend-links-dialog-empty muted">{t('home.noFriendLinks')}</p>
              )}
            </section>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
