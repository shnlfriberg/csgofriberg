import { Link } from 'react-router-dom';
import { AlertTriangle, Home, RotateCcw } from 'lucide-react';
import Page from './Page';
import { useTranslation } from 'react-i18next';

/** 路由级错误兜底:任何页面渲染异常都落到这里,而不是整页空白 */
export default function RouteError() {
  const { t } = useTranslation();
  return (
    <Page title={t('errorPage.title')} icon={<AlertTriangle size={17} />}>
      <div className="game-empty">
        <AlertTriangle size={32} strokeWidth={1.5} />
        <p className="game-empty-title">{t('errorPage.title')}</p>
        <p>{t('errorPage.message')}</p>
        <div className="game-empty-actions">
          <button className="btn" type="button" onClick={() => window.location.reload()}>
            <RotateCcw size={15} />
            {t('errorPage.reload')}
          </button>
          <Link to="/" className="btn btn-ghost">
            <Home size={15} />
            {t('common.home')}
          </Link>
        </div>
      </div>
    </Page>
  );
}
