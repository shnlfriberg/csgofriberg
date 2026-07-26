import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom';
import { useAuth } from './store/auth';
import Home from './pages/Home';
import Login from './pages/Login';
import Search from './pages/Search';
import SingleGame from './pages/SingleGame';
import SingleLobby from './pages/SingleLobby';
import MultiLobby from './pages/MultiLobby';
import MultiRoom from './pages/MultiRoom';
import Stats from './pages/Stats';
import Leaderboard from './pages/Leaderboard';
import Announcements from './pages/Announcements';
import Admin from './pages/Admin';
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
    children: [
      { path: '/', element: <Home /> },
      { path: '/login', element: <Login /> },
      { path: '/search', element: <Search /> },
      { path: '/single', element: <SingleLobby /> },
      { path: '/single/:mode', element: <SingleGame /> },
      { path: '/multi', element: <MultiLobby /> },
      { path: '/multi/room', element: <MultiRoom /> },
      { path: '/stats', element: <Stats /> },
      { path: '/leaderboard', element: <Leaderboard /> },
      { path: '/announcement', element: <Announcements /> },
      {
        element: <RequireAdmin />,
        children: [{ path: '/admin', element: <Admin /> }],
      },
      { path: '*', element: <NotFound /> },
    ],
  },
]);
