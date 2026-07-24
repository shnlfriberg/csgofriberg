import { lazy, Suspense } from 'react';
import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './store/auth';
import Home from './pages/Home';
import Page from './components/Page';
import { Wrench } from 'lucide-react';
import { useTranslation } from 'react-i18next';

const Login = lazy(() => import('./pages/Login'));
const Search = lazy(() => import('./pages/Search'));
const SingleGame = lazy(() => import('./pages/SingleGame'));
const SingleLobby = lazy(() => import('./pages/SingleLobby'));
const MultiLobby = lazy(() => import('./pages/MultiLobby'));
const MultiRoom = lazy(() => import('./pages/MultiRoom'));
const Stats = lazy(() => import('./pages/Stats'));
const Leaderboard = lazy(() => import('./pages/Leaderboard'));
const Announcements = lazy(() => import('./pages/Announcements'));
const Admin = lazy(() => import('./pages/Admin'));

function route(element: React.ReactNode) {
  return <Suspense fallback={<div className="route-loading"><div className="spinner" /></div>}>
    {element}
  </Suspense>;
}

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
  { path: '/', element: <Home /> },
  { path: '/login', element: route(<Login />) },
  { path: '/search', element: route(<Search />) },
  { path: '/single', element: route(<SingleLobby />) },
  { path: '/single/:mode', element: route(<SingleGame />) },
  { path: '/multi', element: route(<MultiLobby />) },
  { path: '/multi/room', element: route(<MultiRoom />) },
  { path: '/stats', element: route(<Stats />) },
  { path: '/leaderboard', element: route(<Leaderboard />) },
  { path: '/announcement', element: route(<Announcements />) },
  {
    element: <RequireAdmin />,
    children: [{ path: '/admin', element: route(<Admin />) }],
  },
  { path: '*', element: <Navigate to="/" replace /> },
]);
