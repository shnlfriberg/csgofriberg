import { Settings, Sparkles, X } from 'lucide-react';
import axios from 'axios';
import { useCallback, useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import { getMotionEnabled, setMotionEnabled, subscribeMotion } from '../store/motion';
import ModalPortal from './ModalPortal';
import { api, errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { toast } from './Toast';

function maskVerifiedEmail(email: string | null | undefined): string {
  if (!email) return '';
  const separator = email.indexOf('@');
  if (separator <= 0) return email;
  return `${email.slice(0, 1)}**${email.slice(separator)}`;
}

export default function PersonalSettings() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const motionEnabled = useSyncExternalStore(subscribeMotion, getMotionEnabled, () => true);
  const user = useAuth((state) => state.user);
  const setUser = useAuth((state) => state.setUser);
  const [email, setEmail] = useState('');
  const [emailLoading, setEmailLoading] = useState(false);
  const [emailCooldownUntil, setEmailCooldownUntil] = useState(0);
  const [emailCooldownSeconds, setEmailCooldownSeconds] = useState(0);
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

  useEffect(() => {
    if (!open || !user) return;
    void api.get('/auth/me').then((response) => {
      if (response.data?.user) setUser(response.data.user);
    }).catch(() => undefined);
  }, [open, setUser, user?.id]);

  useEffect(() => {
    if (!emailCooldownUntil) {
      setEmailCooldownSeconds(0);
      return;
    }
    const update = () => {
      const seconds = Math.max(0, Math.ceil((emailCooldownUntil - Date.now()) / 1000));
      setEmailCooldownSeconds(seconds);
      if (!seconds) setEmailCooldownUntil(0);
    };
    update();
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [emailCooldownUntil]);

  const applyEmailCooldown = useCallback((data: unknown) => {
    const value = data as { retryAt?: unknown; serverNow?: unknown } | null;
    const retryAt = Number(value?.retryAt);
    const serverNow = Number(value?.serverNow);
    if (!Number.isFinite(retryAt)) return;
    const remaining = Number.isFinite(serverNow)
      ? Math.max(0, retryAt - serverNow)
      : Math.max(0, retryAt - Date.now());
    setEmailCooldownUntil(Date.now() + remaining);
  }, []);

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
                {user && (
                  <form className="settings-email" onSubmit={async (event) => {
                    event.preventDefault();
                    if (!email.trim()) return;
                    setEmailLoading(true);
                    try {
                      const response = await api.post('/auth/email/request', { email: email.trim() });
                      applyEmailCooldown(response.data);
                      setUser({ ...user, email: email.trim().toLowerCase(), emailVerified: false });
                      toast.success(t('settings.emailSent'));
                    } catch (error) {
                      if (axios.isAxiosError(error) && error.response?.data?.code === 'EMAIL_VERIFICATION_COOLDOWN') {
                        applyEmailCooldown(error.response.data);
                      }
                      toast.error(errMsg(error));
                    }
                    finally { setEmailLoading(false); }
                  }}>
                    <span className="settings-option-label">{t('settings.email')}</span>
                    <input className="input" type="email" value={user.emailVerified ? maskVerifiedEmail(user.email) : email || user.email || ''} disabled={user.emailVerified} onChange={(event) => setEmail(event.target.value)} placeholder={t('settings.emailPlaceholder')} />
                    <span className="muted">{user.emailVerified ? t('settings.emailLocked') : t('settings.emailUnverified')}</span>
                    <button className="btn btn-sm" type="submit" disabled={user.emailVerified || emailLoading || emailCooldownSeconds > 0 || !email.trim()}>
                      {emailCooldownSeconds > 0
                        ? t('settings.sendVerificationCooldown', { seconds: emailCooldownSeconds })
                        : t('settings.sendVerification')}
                    </button>
                  </form>
                )}
              </div>
            </div>
          </div>
        </ModalPortal>
      )}
    </>
  );
}
