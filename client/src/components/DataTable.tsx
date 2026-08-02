import { ReactNode } from 'react';
import styles from './DataTable.module.css';
import { useTranslation } from 'react-i18next';

export interface Column<T> {
  key: string;
  title: ReactNode;
  render?: (row: T) => ReactNode;
}

interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string | number;
  empty?: string;
  /** 加载中:空数据时显示骨架而非空态文案,表格容器标记 aria-busy */
  loading?: boolean;
}

/** 通用数据表格 */
export default function DataTable<T>({ columns, rows, rowKey, empty, loading }: Props<T>) {
  const { t } = useTranslation();
  if (!rows.length) {
    if (loading) {
      return (
        <div className="table-skeleton" role="status" aria-label={t('common.loading')}>
          <i /><i /><i /><i /><i />
        </div>
      );
    }
    return <p className="muted">{empty ?? t('common.noData')}</p>;
  }
  return (
    <div className={styles.scroll} aria-busy={loading || undefined}>
      <table className={styles.table}>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key}>{c.title}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={rowKey(row)}>
              {columns.map((c) => (
                <td key={c.key}>
                  {c.render ? c.render(row) : String((row as any)[c.key] ?? '')}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
