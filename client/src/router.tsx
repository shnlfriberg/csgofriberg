import { lazy, Suspense } from 'react';
const CardLink = lazy(() => import('./pages/CardLink'));
const TurtleSoupLobby = lazy(() => import('./pages/TurtleSoupLobby'));
// Entertainment pages load on demand, so the 图寻 styles stay out of the main bundle.
const Entertainment = lazy(() => import('./pages/Entertainment'));
const LocationMenu = lazy(() => import('./pages/LocationMenu'));
const LocationGame = lazy(() => import('./pages/LocationGame'));
const LocationMulti = lazy(() => import('./pages/LocationMulti'));
const LocationHistory = lazy(() => import('./pages/LocationHistory'));
const LocationSubmission = lazy(() => import('./pages/LocationSubmission'));
const TurtleSoupGame = lazy(() => import('./pages/TurtleSoupGame'));
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './store/auth';
import Home from './pages/Home';
import Login from './pages/Login';
import EmailVerify from './pages/EmailVerify';
import PasswordReset from './pages/PasswordReset';
const Search = lazy(() => import('./pages/Search'));
const SingleGame = lazy(() => import('./pages/SingleGame'));
import SingleLobby from './pages/SingleLobby';
import MultiLobby from './pages/MultiLobby';
const MultiRoom = lazy(() => import('./pages/MultiRoom'));
const Stats = lazy(() => import('./pages/Stats'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
import Announcements from './pages/Announcements';
import DailyLobby from './pages/DailyLobby';
const DailyChallenge = lazy(() => import('./pages/DailyChallenge'));
const Admin = lazy(() => import('./pages/Admin'));
import NotFound from './pages/NotFound';
import RouteError from './components/RouteError';
import Page from './components/Page';
import { Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/* 所有游戏与数据页面均不强制登录,仅管理后台需要管理员身份 */
function RequireAdmin() {
  const { t } = useTranslation();
  const { user, initialized } = useAuth();
  if (!initialized) {
    return (
      <Page title={t('admin.title')} icon={<Wrench size={17} />}>
        <div className="page-loading" aria-label={t('home.restoring')}>
          <div className="spinner" />
        </div>
      </Page>
    );
  }
  return user?.role === 'admin' ? <Outlet /> : <Navigate to="/" replace />;
}

export const router = createBrowserRouter([
  {
    errorElement: <RouteError />,
    element: <Suspense fallback={<div className="page-loading" role="status"><div className="spinner" /></div>}><Outlet /></Suspense>,
    children: [
      { path: '/', element: <Home /> },
      { path: '/login', element: <Login /> },
      { path: '/email-verify', element: <EmailVerify /> },
      { path: '/password-reset', element: <PasswordReset /> },
      { path: '/search', element: <Search /> },
      { path: '/single', element: <SingleLobby /> },
      { path: '/entertainment', element: <Entertainment /> },
      { path: '/entertainment/location', element: <LocationMenu /> },
      { path: '/entertainment/card-link', element: <CardLink /> },
      { path: '/entertainment/location/submit', element: <LocationSubmission /> },
      { path: '/entertainment/location/random', element: <LocationGame mode="random" /> },
      { path: '/entertainment/location/daily', element: <LocationGame mode="daily" /> },
      { path: '/entertainment/location/multi', element: <LocationMulti /> },
      { path: '/entertainment/location/history', element: <LocationHistory /> },
      { path: '/turtle-soup', element: <TurtleSoupLobby /> },
      { path: '/turtle-soup/:mode', element: <TurtleSoupGame /> },
      { path: '/single/:mode', element: <SingleGame /> },
      { path: '/daily', element: <DailyLobby /> },
      { path: '/daily/:mode', element: <DailyChallenge /> },
      { path: '/multi', element: <MultiLobby /> },
      { path: '/multi/room', element: <MultiRoom /> },
      { path: '/stats', element: <Stats /> },
      { path: '/leaderboard', element: <Leaderboard /> },
      { path: '/announcement', element: <Announcements /> },
      {
        element: <RequireAdmin />,
        children: [{ path: '/admin/*', element: <Admin /> }],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
