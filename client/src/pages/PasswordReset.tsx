import { FormEvent, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import Page from '../components/Page';
import { api, errMsg } from '../api/client';
import { requestGeeTest } from '../api/geetest';
import { clearAuthenticated } from '../api/authSession';
import { closeSocket } from '../api/socket';
import { useAuth } from '../store/auth';

export default function PasswordReset() {
  const { t } = useTranslation();
  const [username, setUsername] = useState('');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const inFlight = useRef(false);
  const [retryAt, setRetryAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [sent, setSent] = useState(false);
  const [done, setDone] = useState(false);
  const [error, setError] = useState('');
  const seconds = Math.max(0, Math.ceil((retryAt - now) / 1000));
  useEffect(() => {
    if (!retryAt) return;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [retryAt]);

  const validEmail = () => email.trim().length <= 320 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.trim());
  const validateUsername = () => {
    if (!username) { setError(t('auth.usernameRequired')); return false; }
    if (username.length < 2 || username.length > 20) { setError(t('auth.usernameLength')); return false; }
    if (!/^[\w一-龥-]+$/.test(username)) { setError(t('auth.usernameCharacters')); return false; }
    return true;
  };
  const run = async (action: () => Promise<void>) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true); setError('');
    try { await action(); }
    catch (err) {
      setError(err instanceof Error && err.message.startsWith('GEETEST_') ? t('errors.GEETEST_FAILED') : errMsg(err));
    } finally { inFlight.current = false; setBusy(false); }
  };
  const send = () => {
    if (seconds) return;
    if (!validateUsername()) return;
    if (!validEmail()) { setError(t('auth.emailInvalid')); return; }
    void run(async () => {
      const challenge = await requestGeeTest();
      if (challenge.enabled && !challenge.proof) return;
      const response = await api.post('/auth/password/request', { username, email: email.trim(), ...(challenge.proof ?? {}) });
      setNow(Date.now());
      setRetryAt(Date.now() + (response.data.retryAfterSeconds || 30) * 1000);
      setSent(true);
    });
  };
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!validateUsername()) return;
    if (!validEmail()) { setError(t('auth.emailInvalid')); return; }
    if (!/^\d{6}$/.test(code)) { setError(t('recovery.codeFormat')); return; }
    if (password.length < 10 || password.length > 128) { setError(t('auth.passwordLength')); return; }
    if (password !== confirmation) { setError(t('auth.mismatch')); return; }
    void run(async () => {
      await api.post('/auth/password/reset', { username, email: email.trim(), code, password });
      clearAuthenticated(); useAuth.getState().setUser(null); closeSocket();
      setPassword(''); setConfirmation(''); setCode(''); setDone(true);
    });
  };

  return <Page title={t('recovery.title')} icon={<KeyRound size={17} />}>
    <div className="card auth-card">
      {done ? <p role="status">{t('recovery.success', { username })}</p> : <>
        <p className="muted">{t('recovery.description')}</p>
        <form className="form" onSubmit={submit} noValidate aria-busy={busy}>
          <label className="auth-field">{t('auth.username')}
            <input className="input" autoComplete="username" maxLength={20} value={username} disabled={busy}
              onChange={(e) => { setUsername(e.target.value); setSent(false); setCode(''); }} />
          </label>
          <label className="auth-field">{t('recovery.email')}
            <input className="input" type="email" autoComplete="email" maxLength={320} value={email} disabled={busy}
              onChange={(e) => { setEmail(e.target.value); setSent(false); setCode(''); }} />
          </label>
          <button type="button" className="btn btn-ghost" disabled={busy || seconds > 0} onClick={send}>
            {seconds > 0 ? t('settings.sendVerificationCooldown', { seconds }) : t('settings.sendVerification')}
          </button>
          {sent && <p role="status">{t('recovery.sent')}</p>}
          <label className="auth-field">{t('settings.emailCode')}
            <input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code}
              disabled={busy} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
          </label>
          <label className="auth-field">{t('recovery.newPassword')}
            <input className="input" type="password" autoComplete="new-password" maxLength={128} value={password}
              disabled={busy} onChange={(e) => setPassword(e.target.value)} />
          </label>
          <label className="auth-field">{t('auth.confirmPassword')}
            <input className="input" type="password" autoComplete="new-password" maxLength={128} value={confirmation}
              disabled={busy} onChange={(e) => setConfirmation(e.target.value)} />
          </label>
          {error && <p role="alert" className="auth-field-error">{error}</p>}
          <button className="btn" disabled={busy}>{busy ? t('common.loading') : t('recovery.submit')}</button>
        </form>
      </>}
      <Link className="btn btn-ghost" to="/login">{t('recovery.back')}</Link>
    </div>
  </Page>;
}
