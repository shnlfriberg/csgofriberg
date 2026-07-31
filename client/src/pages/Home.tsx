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
import HomeSpecialThanks from '../components/HomeSpecialThanks';
import HomeFriendLinks from '../components/HomeFriendLinks';
import PersonalSettings from '../components/PersonalSettings';
import wanjiqiImage from '../assets/wjq.jpg';

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true" fill="currentColor">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

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
    document.title = `${t('common.brand')} - ${t('home.subtitle')}`;
  }, [t]);

  useEffect(() => {
    void fetch('/api/health', { credentials: 'include' })
      .then((response) => response.ok ? response.json() : null)
      .then((data: { features?: { leaderboard?: boolean } } | null) => {
        setShowLeaderboard(typeof data?.features?.leaderboard === 'boolean' ? data.features.leaderboard : true);
      })
      .catch(() => setShowLeaderboard(true));
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
      <a className="skip-link" href="#main-content">
        {t('common.skipToContent')}
      </a>
      <div className="header-bar">
        <div className="home-brand">
          <span className="home-brand-slashes" aria-hidden="true">//</span>
          <img className="home-brand-logo" src={wanjiqiImage} alt="" />
          <span className="title">{t('common.brand')}</span>
        </div>
        <span className="btns">
          <LanguageSelect />
          <PersonalSettings />
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
                <Link className="btn btn-ghost btn-sm" to="/admin" aria-label={t('home.adminPanel')}>
                  <Wrench size={15} />
                  <span className="btn-text">{t('home.manage')}</span>
                </Link>
              )}
              <button
                className="btn btn-ghost btn-sm"
                aria-label={t('home.logout')}
                onClick={() => void logout()}
                disabled={loggingOut}
              >
                <LogOut size={15} />
                <span className="btn-text">{t('home.logout')}</span>
              </button>
            </>
          ) : (
            <>
              <span className="muted">{guestName === '访客' ? t('common.guest') : guestName}</span>
              <Link className="btn btn-sm" to="/login" aria-label={t('home.loginRegister')}>
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
          <a
            className="home-sponsor-link"
            href="https://www.douyu.com/6979222"
            target="_blank"
            rel="noopener noreferrer"
            data-umami-event="home-wanjiqi-sponsor"
          >
            {t('home.titleSponsor')}
          </a>
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
          />
          <MenuCard
            to="/multi"
            icon={<Globe size={22} />}
            label={t('home.multiplayer')}
            description={t('home.multiplayerDescription')}
            color="#ffb64e"
          />
          <MenuCard
            to="/search"
            icon={<Search size={22} />}
            label={t('home.search')}
            description={t('home.searchDescription')}
            color="#65a8ff"
          />
        </div>
        <div className="bottom-bar">
          <Link to="/stats" className="btn">
            <BarChart3 size={15} />
            {t('home.stats')}
          </Link>
          {showLeaderboard && (
            <Link to="/leaderboard" className="btn btn-warning">
              <Trophy size={15} />
              {t('home.leaderboard')}
            </Link>
          )}
          <Link to="/announcement" className="btn btn-success">
            <Megaphone size={15} />
            {t('home.announcements')}
          </Link>
          <HomeSpecialThanks />
          <HomeFriendLinks />
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
          <a
            href="https://github.com/shnlfriberg/csgofriberg"
            className="btn btn-github"
            target="_blank"
            rel="noopener noreferrer"
            data-umami-event="home-github"
          >
            <GitHubIcon />
            {t('home.github')}
          </a>
        </div>
      </main>
    </div>
  );
}
