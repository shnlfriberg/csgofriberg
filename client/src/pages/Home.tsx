import { useEffect, useSyncExternalStore, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Search,
  Gamepad2,
  Globe,
  BarChart3,
  Trophy,
  Megaphone,
  LogIn,
  LogOut,
  Wrench,
} from 'lucide-react';
import MenuCard from '../components/MenuCard';
import GameRules from '../components/GameRules';
import { useAuth } from '../store/auth';
import { getGuestName, subscribeGuestName } from '../store/guest';
import { api, errMsg } from '../api/client';
import { clearAuthenticated } from '../api/session';
import { markGuestSession } from '../api/session';
import { useConfirm } from '../components/ConfirmDialog';
import ThemeToggle from '../components/ThemeToggle';
import { toast } from '../components/Toast';
import { useTranslation } from 'react-i18next';
import LanguageSelect from '../components/LanguageSelect';

function BilibiliIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      aria-hidden="true"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="m8 3 2.5 3M16 3l-2.5 3" />
      <rect x="3" y="6" width="18" height="14" rx="3" />
      <path d="M8 12v2M16 12v2" />
    </svg>
  );
}

export default function Home() {
  const { t } = useTranslation();
  const { user, initialized, setUser } = useAuth();
  const navigate = useNavigate();
  const confirm = useConfirm();
  const [loggingOut, setLoggingOut] = useState(false);
  const [showLeaderboard, setShowLeaderboard] = useState(true);
  const guestName = useSyncExternalStore(subscribeGuestName, getGuestName, () => '访客');

  useEffect(() => {
    void fetch('/api/health', { credentials: 'include' })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { features?: { leaderboard?: boolean } } | null) => {
        if (typeof data?.features?.leaderboard === 'boolean') {
          setShowLeaderboard(data.features.leaderboard);
        }
      })
      .catch(() => undefined);
  }, []);

  const logout = async () => {
    if (!await confirm({
      title: t('home.logoutTitle'),
      message: t('home.logoutMessage'),
      confirmLabel: t('home.logoutConfirm'),
      tone: 'warning',
    })) return;
    setLoggingOut(true);
    try {
      await api.post('/auth/logout');
      const { closeSocket } = await import('../api/socket');
      closeSocket();
      clearAuthenticated();
      markGuestSession();
      setUser(null);
      const { getSocket } = await import('../api/socket');
      getSocket();
      navigate('/');
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoggingOut(false);
    }
  };

  return (
    <div className="page home-page">
      <div className="header-bar">
        <span className="title">{t('common.brand')}</span>
        <span className="btns">
          <LanguageSelect />
          <ThemeToggle />
          {!initialized ? (
            <span className="auth-pending" aria-label={t('home.restoring')} />
          ) : user ? (
            <>
              <span className="muted">
                {user.username}
                {user.role === 'admin' && ` · ${t('home.admin')}`}
              </span>
              {user.role === 'admin' && (
                <Link className="btn btn-ghost btn-sm" to="/admin" aria-label={t('home.adminPanel')} data-umami-event="home-admin">
                  <Wrench size={15} />
                  <span className="btn-text">{t('home.manage')}</span>
                </Link>
              )}
              <button
                className="btn btn-ghost btn-sm"
                aria-label={t('home.logout')}
                onClick={() => void logout()}
                disabled={loggingOut}
                data-umami-event="home-logout"
              >
                <LogOut size={15} />
                <span className="btn-text">{t('home.logout')}</span>
              </button>
            </>
          ) : (
            <>
              <span className="muted">{guestName === '访客' ? t('common.guest') : guestName}</span>
              <Link className="btn btn-sm" to="/login" aria-label={t('home.loginRegister')} data-umami-event="home-login">
                <LogIn size={15} />
                <span className="btn-text">{t('home.loginRegister')}</span>
              </Link>
            </>
          )}
        </span>
      </div>
      <main className="page-scroll" id="main-content">
        <div className="home-hero">
          <span className="hero-kicker">CS MAJOR // PLAYER GUESSING</span>
          <h1>{t('common.brand')}</h1>
          <p className="hero-subtitle">{t('home.subtitle')}</p>
          <GameRules />
          {initialized && !user && (
            <p className="muted" style={{ marginTop: 6 }}>
              {t('home.guestHint')}
            </p>
          )}
        </div>
        <div className="menu-grid">
          <MenuCard
            to="/single"
            icon={<Gamepad2 size={22} />}
            label={t('home.singleMode')}
            description={t('home.singleModeDescription')}
            color="#74e38f"
            analyticsEvent="home-mode-single"
          />
          <MenuCard
            to="/search"
            icon={<Search size={22} />}
            label={t('home.search')}
            description={t('home.searchDescription')}
            color="#65a8ff"
            analyticsEvent="home-mode-search"
          />
          <MenuCard
            to="/multi"
            icon={<Globe size={22} />}
            label={t('home.multiplayer')}
            description={t('home.multiplayerDescription')}
            color="#ffb64e"
            analyticsEvent="home-mode-multiplayer"
          />
        </div>
        <div className="bottom-bar">
          <Link to="/stats" className="btn" data-umami-event="home-stats">
            <BarChart3 size={15} />
            {t('home.stats')}
          </Link>
          {showLeaderboard && (
            <Link to="/leaderboard" className="btn btn-warning" data-umami-event="home-leaderboard">
              <Trophy size={15} />
              {t('home.leaderboard')}
            </Link>
          )}
          <Link to="/announcement" className="btn btn-success" data-umami-event="home-announcements">
            <Megaphone size={15} />
            {t('home.announcements')}
          </Link>
          <a
            href="https://space.bilibili.com/290893104"
            className="btn btn-bilibili"
            target="_blank"
            rel="noopener noreferrer"
            data-umami-event="home-bilibili"
          >
            <BilibiliIcon />
            {t('home.bilibili')}
          </a>
        </div>
      </main>
    </div>
  );
}
