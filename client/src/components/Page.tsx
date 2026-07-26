import { ReactNode, useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Home } from 'lucide-react';
import ThemeToggle from './ThemeToggle';
import { useTranslation } from 'react-i18next';

interface Props {
  title: string;
  className?: string;
  icon?: ReactNode;
  /** 顶栏右侧动作区 */
  actions?: ReactNode;
  /** 顶栏下方状态条 */
  statusBar?: ReactNode;
  children: ReactNode;
  /** 底部固定输入区(含自动补全) */
  dock?: ReactNode;
  showHome?: boolean;
}

/**
 * 页面骨架:顶栏 + 可选状态条 + 滚动内容区 + 可选底部输入坞。
 * 满高布局,移动端输入栏贴底并处理安全区。
 */
export default function Page({
  title,
  className,
  icon,
  actions,
  statusBar,
  children,
  dock,
  showHome = true,
}: Props) {
  const { t } = useTranslation();
  useEffect(() => {
    document.title = `${title} · ${t('common.brand')}`;
  }, [title, t]);
  return (
    <div className={`page${className ? ` ${className}` : ''}`}>
      <a className="skip-link" href="#main-content">
        {t('common.skipToContent')}
      </a>
      <div className="header-bar">
        <span className="title">
          {icon}
          {title}
        </span>
        <span className="btns">
          {actions}
          <ThemeToggle />
          {showHome && (
            <Link to="/" className="btn btn-ghost btn-sm" aria-label={t('common.home')}>
              <Home size={15} />
              <span className="btn-text">{t('common.home')}</span>
            </Link>
          )}
        </span>
      </div>
      {statusBar && <div className="status-bar">{statusBar}</div>}
      <main className="page-scroll" id="main-content">
        {children}
      </main>
      {dock && <div className="input-dock">{dock}</div>}
    </div>
  );
}
