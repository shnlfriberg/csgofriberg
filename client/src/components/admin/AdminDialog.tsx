import { useEffect, useId, useRef, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import ModalPortal from '../ModalPortal';

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])';

/**
 * Admin modal: centred dialog, or a right-hand drawer for record details.
 * Handles Escape, focus trap, body scroll lock and focus restore.
 */
export default function AdminDialog({
  title,
  subtitle,
  icon,
  onClose,
  children,
  footer,
  variant = 'dialog',
  size = 'md',
  className,
  /** Let a nested modal (e.g. a replay viewer) own the keyboard while it is open. */
  suspended = false,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  icon?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  variant?: 'dialog' | 'drawer';
  size?: 'sm' | 'md' | 'lg';
  className?: string;
  suspended?: boolean;
}) {
  const { t } = useTranslation();
  const titleId = useId();
  const ref = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const suspendedRef = useRef(suspended);
  onCloseRef.current = onClose;
  suspendedRef.current = suspended;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      const dialog = ref.current;
      if (!dialog || (document.activeElement instanceof Node && dialog.contains(document.activeElement))) return;
      const body = dialog.querySelector<HTMLElement>('.admin-dialog-body');
      (body?.querySelector<HTMLElement>(FOCUSABLE) ?? dialog.querySelector<HTMLElement>(FOCUSABLE) ?? dialog).focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (suspendedRef.current) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        onCloseRef.current();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);

  return (
    <ModalPortal>
      <div
        className={`admin-dialog-backdrop is-${variant}`}
        onMouseDown={(event) => { if (event.target === event.currentTarget && !suspendedRef.current) onClose(); }}
      >
        <div
          ref={ref}
          className={`admin-dialog is-${variant} is-${size}${className ? ` ${className}` : ''}`}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          tabIndex={-1}
        >
          <header className="admin-dialog-head">
            <div>
              <h2 id={titleId}>{icon}{title}</h2>
              {subtitle && <p>{subtitle}</p>}
            </div>
            <button className="admin-icon-btn" type="button" aria-label={t('common.close')} onClick={onClose}>
              <X size={17} />
            </button>
          </header>
          <div className="admin-dialog-body">{children}</div>
          {footer && <footer className="admin-dialog-foot">{footer}</footer>}
        </div>
      </div>
    </ModalPortal>
  );
}
