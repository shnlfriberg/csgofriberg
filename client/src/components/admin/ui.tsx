import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { ChevronLeft, ChevronRight, Search } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/** Shared building blocks for every admin page: one panel, toolbar, filter and pagination style. */

export function Panel({
  title,
  description,
  actions,
  children,
  className,
  flush = false,
  id,
}: {
  title?: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
  /** Let tables run edge to edge inside the panel. */
  flush?: boolean;
  id?: string;
}) {
  return (
    <section className={`admin-panel${className ? ` ${className}` : ''}`} aria-labelledby={title && id ? id : undefined}>
      {(title || actions) && (
        <header className="admin-panel-head">
          <div className="admin-panel-title">
            {title && <h2 id={id}>{title}</h2>}
            {description && <p>{description}</p>}
          </div>
          {actions && <div className="admin-panel-actions">{actions}</div>}
        </header>
      )}
      <div className={`admin-panel-body${flush ? ' is-flush' : ''}`}>{children}</div>
    </section>
  );
}

export function Toolbar({ children, end }: { children?: ReactNode; end?: ReactNode }) {
  return (
    <div className="admin-toolbar">
      {children && <div className="admin-toolbar-filters">{children}</div>}
      {end && <div className="admin-toolbar-end">{end}</div>}
    </div>
  );
}

export function SearchBox({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
}) {
  return (
    <label className="admin-search">
      <Search size={15} aria-hidden="true" />
      <input
        className="input"
        type="search"
        value={value}
        aria-label={placeholder}
        placeholder={placeholder}
        onChange={(event) => onChange(event.target.value)}
      />
    </label>
  );
}

export function FilterSelect<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <label className="admin-filter">
      <span>{label}</span>
      <select className="input" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value as T)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

/** Mutually exclusive quick filter (e.g. pending / handled / all). */
export function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: Array<{ value: T; label: string }>;
  onChange: (value: T) => void;
}) {
  return (
    <div className="admin-segmented" role="group" aria-label={label}>
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => option.value !== value && onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

export function Pagination({
  page,
  totalPages,
  total,
  pageSize,
  loading = false,
  onPage,
  onPageSize,
  pageSizes = [20, 50, 100],
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: number;
  loading?: boolean;
  onPage: (page: number) => void;
  onPageSize?: (size: number) => void;
  pageSizes?: number[];
}) {
  const { t } = useTranslation();
  const pages = Math.max(1, totalPages);
  return (
    <div className="admin-pagination">
      <span className="admin-pagination-summary">
        {total ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} / ${total}` : t('admin.zeroItems')}
      </span>
      <div className="admin-pagination-actions">
        {onPageSize && (
          <label className="admin-page-size">
            <span>{t('admin.pageSize')}</span>
            <select className="input" value={pageSize} onChange={(event) => onPageSize(Number(event.target.value))}>
              {pageSizes.map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        )}
        <button
          className="admin-icon-btn"
          type="button"
          aria-label={t('common.previousPage')}
          title={t('common.previousPage')}
          disabled={loading || page <= 1}
          onClick={() => onPage(Math.max(1, page - 1))}
        >
          <ChevronLeft size={16} />
        </button>
        <span className="admin-pagination-page">{t('admin.pageOf', { page, total: pages })}</span>
        <button
          className="admin-icon-btn"
          type="button"
          aria-label={t('common.nextPage')}
          title={t('common.nextPage')}
          disabled={loading || page >= pages}
          onClick={() => onPage(page + 1)}
        >
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

/** Cursor-style pager for lists that only know whether a next page exists. */
export function SimplePager({
  page,
  hasNext,
  loading = false,
  onPage,
}: {
  page: number;
  hasNext: boolean;
  loading?: boolean;
  onPage: (page: number) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="admin-pagination is-simple">
      <div className="admin-pagination-actions">
        <button className="admin-icon-btn" type="button" aria-label={t('common.previousPage')} disabled={loading || page <= 1} onClick={() => onPage(Math.max(1, page - 1))}>
          <ChevronLeft size={16} />
        </button>
        <span className="admin-pagination-page">{t('common.page', { page })}</span>
        <button className="admin-icon-btn" type="button" aria-label={t('common.nextPage')} disabled={loading || !hasNext} onClick={() => onPage(page + 1)}>
          <ChevronRight size={16} />
        </button>
      </div>
    </div>
  );
}

export function StatCard({
  label,
  value,
  hint,
  icon,
  tone = 'default',
  to,
  ariaLabel,
}: {
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  icon?: ReactNode;
  tone?: 'default' | 'primary' | 'warning' | 'danger' | 'success';
  to?: string;
  ariaLabel?: string;
}) {
  const body = (
    <>
      <span className="admin-stat-label">{icon}{label}</span>
      <strong className="admin-stat-value">{value}</strong>
      {hint && <span className="admin-stat-hint">{hint}</span>}
    </>
  );
  const className = `admin-stat admin-stat-${tone}`;
  return to
    ? <Link className={`${className} is-link`} to={to} aria-label={ariaLabel}>{body}</Link>
    : <div className={className}>{body}</div>;
}

/** Labelled on/off control. The checkbox keeps its native role; CSS draws it as a switch. */
export function SwitchRow({
  title,
  description,
  checked,
  disabled,
  onChange,
  onText,
  offText,
}: {
  title: ReactNode;
  description?: ReactNode;
  checked: boolean;
  disabled?: boolean;
  onChange: (checked: boolean) => void;
  onText: string;
  offText: string;
}) {
  return (
    <div className="admin-switch-row">
      <div className="admin-switch-copy">
        <strong>{title}</strong>
        {description && <span>{description}</span>}
      </div>
      <label className="admin-switch">
        <input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} />
        <span>{checked ? onText : offText}</span>
      </label>
    </div>
  );
}

export function formatDateTime(value: string | number | null | undefined, locale: string): string {
  if (value == null || value === '') return '-';
  const date = new Date(typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString(locale);
}
