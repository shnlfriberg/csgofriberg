import { CSSProperties, FormEvent, useState, useSyncExternalStore } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import Page from '../components/Page';
import { api, errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { closeSocket, getSocket } from '../api/socket';
import { markAuthenticated } from '../api/session';
import { toast } from '../components/Toast';
import { useTranslation } from 'react-i18next';
import { getPowProgress, subscribePowProgress } from '../api/pow';

const INACTIVE_POW_PROGRESS = { active: false, percent: 0 };
const USERNAME_PATTERN = /^[\w一-龥-]+$/;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+$/;

type RegisterField = 'username' | 'password' | 'confirmPassword' | 'email';
type RegisterErrors = Partial<Record<RegisterField, string>>;

export default function Login() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [email, setEmail] = useState('');
  const [registerErrors, setRegisterErrors] = useState<RegisterErrors>({});
  const [loading, setLoading] = useState(false);
  const powProgress = useSyncExternalStore(
    subscribePowProgress,
    getPowProgress,
    () => INACTIVE_POW_PROGRESS
  );
  const setUser = useAuth((s) => s.setUser);
  const navigate = useNavigate();

  const clearRegisterError = (field: RegisterField) => {
    setRegisterErrors((current) => {
      if (!current[field]) return current;
      const next = { ...current };
      delete next[field];
      return next;
    });
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (mode === 'register') {
      const errors: RegisterErrors = {};
      if (!username) errors.username = t('auth.usernameRequired');
      else if (username.length < 2 || username.length > 20) errors.username = t('auth.usernameLength');
      else if (!USERNAME_PATTERN.test(username)) errors.username = t('auth.usernameCharacters');
      if (!password) errors.password = t('auth.passwordRequired');
      else if (password.length < 10 || password.length > 128) errors.password = t('auth.passwordLength');
      if (password !== confirmPassword) errors.confirmPassword = t('auth.mismatch');
      if (email && (email.length > 320 || !EMAIL_PATTERN.test(email.trim()))) {
        errors.email = t('auth.emailInvalid');
      }
      setRegisterErrors(errors);
      const firstInvalid = Object.keys(errors)[0];
      if (firstInvalid) {
        (e.currentTarget.elements.namedItem(firstInvalid) as HTMLElement | null)?.focus();
        return;
      }
    }
    setLoading(true);
    try {
      const res = await api.post(`/auth/${mode}`, { username, password, ...(mode === 'register' && email ? { email } : {}) });
      markAuthenticated();
      setUser(res.data.user);
      closeSocket();
      getSocket();
      // 把匿名期间的对局并入账号(失败不阻塞登录)
      try {
        await api.post('/auth/claim');
      } catch (err) {
        toast.error(t('auth.claimFailed', { message: errMsg(err) }));
      }
      navigate('/');
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  };

  return (
    <Page title={mode === 'login' ? t('auth.login') : t('auth.register')} icon={<KeyRound size={17} />}>
      <div className="card auth-card">
        <p className="muted" style={{ textAlign: 'center' }}>
          {t('auth.description')}
        </p>
        <form className="form" onSubmit={submit} noValidate>
          <div className="auth-field">
            <input
              className="input"
              name="username"
              placeholder={t('auth.username')}
              value={username}
              autoComplete="username"
              aria-invalid={Boolean(registerErrors.username)}
              aria-describedby={registerErrors.username ? 'register-username-error' : undefined}
              onChange={(e) => {
                setUsername(e.target.value);
                clearRegisterError('username');
              }}
            />
            {registerErrors.username && (
              <span className="auth-field-error" id="register-username-error">{registerErrors.username}</span>
            )}
          </div>
          {mode === 'register' ? (
            <div className="auth-password-fields">
              <div className="auth-field">
                <input
                  className="input"
                  name="password"
                  type="password"
                  placeholder={t('auth.password')}
                  autoComplete="new-password"
                  value={password}
                  aria-invalid={Boolean(registerErrors.password)}
                  aria-describedby={registerErrors.password ? 'register-password-error' : undefined}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    clearRegisterError('password');
                  }}
                />
                {registerErrors.password && (
                  <span className="auth-field-error" id="register-password-error">{registerErrors.password}</span>
                )}
              </div>
              <div className="auth-field">
                <input
                  className="input"
                  name="confirmPassword"
                  type="password"
                  placeholder={t('auth.confirmPassword')}
                  autoComplete="new-password"
                  value={confirmPassword}
                  aria-invalid={Boolean(registerErrors.confirmPassword)}
                  aria-describedby={registerErrors.confirmPassword ? 'register-confirm-password-error' : undefined}
                  onChange={(e) => {
                    setConfirmPassword(e.target.value);
                    clearRegisterError('confirmPassword');
                  }}
                />
                {registerErrors.confirmPassword && (
                  <span className="auth-field-error" id="register-confirm-password-error">{registerErrors.confirmPassword}</span>
                )}
              </div>
            </div>
          ) : (
            <input
              className="input"
              name="password"
              type="password"
              placeholder={t('auth.password')}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          {mode === 'register' && (
            <div className="auth-field">
              <input
                className="input"
                name="email"
                type="email"
                placeholder={t('auth.emailOptional')}
                autoComplete="email"
                value={email}
                aria-invalid={Boolean(registerErrors.email)}
                aria-describedby={registerErrors.email ? 'register-email-error' : undefined}
                onChange={(e) => {
                  setEmail(e.target.value);
                  clearRegisterError('email');
                }}
              />
              {registerErrors.email && (
                <span className="auth-field-error" id="register-email-error">{registerErrors.email}</span>
              )}
            </div>
          )}
          <button className="btn" disabled={loading} aria-busy={loading}>
            {mode === 'register' && loading && powProgress.active ? (
              <span className="auth-pow-status">
                <span
                  className="auth-pow-ring"
                  style={{ '--pow-progress': `${powProgress.percent}%` } as CSSProperties}
                  aria-hidden="true"
                >
                  <span>{Math.round(powProgress.percent)}%</span>
                </span>
                {t('auth.registerPowComputing')}
              </span>
            ) : mode === 'login' ? t('auth.login') : t('auth.register')}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setConfirmPassword('');
              setEmail('');
              setRegisterErrors({});
              setMode(mode === 'login' ? 'register' : 'login');
            }}
          >
            {mode === 'login' ? t('auth.toRegister') : t('auth.toLogin')}
          </button>
        </form>
      </div>
    </Page>
  );
}
