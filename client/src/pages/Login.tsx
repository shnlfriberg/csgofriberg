import { FormEvent, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound } from 'lucide-react';
import Page from '../components/Page';
import { api, errMsg } from '../api/client';
import { useAuth } from '../store/auth';
import { closeSocket, getSocket } from '../api/socket';
import { markAuthenticated } from '../api/session';
import { toast } from '../components/Toast';
import { useTranslation } from 'react-i18next';

export default function Login() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const setUser = useAuth((s) => s.setUser);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (mode === 'register' && password !== confirmPassword) {
      toast.error(t('auth.mismatch'));
      return;
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
        <form className="form" onSubmit={submit}>
          <input
            className="input"
            placeholder={t('auth.username')}
            value={username}
            autoComplete="username"
            onChange={(e) => setUsername(e.target.value)}
          />
          {mode === 'register' ? (
            <div className="auth-password-fields">
              <input
                className="input"
                type="password"
                placeholder={t('auth.password')}
                autoComplete="new-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <input
                className="input"
                type="password"
                placeholder={t('auth.confirmPassword')}
                autoComplete="new-password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
              />
            </div>
          ) : (
            <input
              className="input"
              type="password"
              placeholder={t('auth.password')}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          )}
          {mode === 'register' && (
            <input
              className="input"
              type="email"
              placeholder={t('auth.emailOptional')}
              autoComplete="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          )}
          <button className="btn" disabled={loading}>
            {mode === 'login' ? t('auth.login') : t('auth.register')}
          </button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => {
              setConfirmPassword('');
              setEmail('');
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
