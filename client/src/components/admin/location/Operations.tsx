import { useEffect, useState } from 'react';
import { HardDrive, RefreshCw } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../location/api';
import { currentLocale } from '../../../i18n';
import { useConfirm } from '../../ConfirmDialog';
import { Panel, StatCard, formatDateTime } from '../ui';
import { useAdminTask } from './useAdminTask';

type Job = { game_id: string; attempts: number; due_at: number; last_error: string | null };
type Metrics = { instance: string; rssBytes: number; collectedAt: string; counters: Record<string, number>;
  timings: Record<string, { count: number; meanMs: number; p95Ms: number }>; outbox: { pending: number; deadLetters: number } };
type Inventory = { items: Array<{ url: string; bytes: number; state: string }> };

const ASSET_STATES = ['referenced', 'staged', 'quarantine-candidate'] as const;

export default function Operations({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const locale = currentLocale();
  const task = useAdminTask();
  const [metrics, setMetrics] = useState<Metrics>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [inventory, setInventory] = useState<Inventory>();
  const load = async () => {
    const [stats, queue] = await Promise.all([api.get<Metrics>('/admin/location/metrics'), api.get<{ items: Job[] }>('/admin/location/outbox')]);
    setMetrics(stats.data); setJobs(queue.data.items);
  };
  useEffect(() => { if (active) void task.run(load); }, [active]);
  const retry = async (job: Job) => {
    if (!await confirm({ title: t('location.retrySettlement'), message: t('location.retrySettlementHelp'), confirmLabel: t('location.retrySettlement') })) return;
    await task.run(async () => { await api.post(`/admin/location/outbox/${encodeURIComponent(job.game_id)}/retry`); await load(); });
  };
  return (
    <div className="admin-stack location-operations">
      <Panel
        id="location-metrics-title"
        title={t('adminUi.metricsTitle')}
        description={t('location.metricsScope')}
        actions={(
          <button className="btn btn-sm" disabled={task.busy} onClick={() => void task.run(load)}>
            <RefreshCw size={15} aria-hidden="true" className={task.busy ? 'admin-spin' : undefined} />{t('location.refreshOperations')}
          </button>
        )}
      >
        {task.error && <p role="alert" className="location-alert">{task.error}</p>}
        {metrics && <>
          <div className="admin-stat-grid">
            <StatCard label={t('location.instance')} value={<span className="admin-mono">{metrics.instance}</span>} hint={formatDateTime(metrics.collectedAt, locale)} />
            <StatCard label="RSS" value={`${(metrics.rssBytes / 1048576).toFixed(1)} MiB`} />
            <StatCard label={t('location.pendingSettlements')} value={metrics.outbox.pending} tone={metrics.outbox.pending ? 'warning' : 'default'} />
            <StatCard label={t('location.deadLetters')} value={metrics.outbox.deadLetters} tone={metrics.outbox.deadLetters ? 'danger' : 'default'} />
          </div>
          <div className="admin-table-scroll location-metrics-table">
            <table>
              <thead><tr><th>{t('location.metric')}</th><th>{t('location.metricCount')}</th><th>{t('location.meanMs')}</th><th>P95 ms</th></tr></thead>
              <tbody>
                {Object.entries(metrics.timings).map(([name, row]) => <tr key={name}><td className="admin-mono">{name}</td><td className="admin-num">{row.count}</td><td className="admin-num">{row.meanMs}</td><td className="admin-num">{row.p95Ms}</td></tr>)}
                {Object.entries(metrics.counters).map(([name, count]) => <tr key={name}><td className="admin-mono">{name}</td><td className="admin-num">{count}</td><td>—</td><td>—</td></tr>)}
              </tbody>
            </table>
          </div>
        </>}
      </Panel>
      <Panel id="location-outbox-title" title={t('adminUi.outboxTitle')} flush>
        {jobs.length ? (
          <div className="admin-table-scroll">
            <table>
              <thead><tr><th>ID</th><th>{t('location.attempts')}</th><th>{t('location.dueAt')}</th><th>{t('location.lastError')}</th><th>{t('admin.actions')}</th></tr></thead>
              <tbody>
                {jobs.map(job => (
                  <tr key={job.game_id}>
                    <td className="admin-mono">{job.game_id}</td>
                    <td className="admin-num">{job.attempts}</td>
                    <td>{formatDateTime(Number(job.due_at), locale)}</td>
                    <td>{job.last_error || '—'}</td>
                    <td><button className="admin-action" disabled={task.busy} onClick={() => void retry(job)}>{t('location.retrySettlement')}</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : <p className="admin-empty">{t('adminUi.outboxEmpty')}</p>}
      </Panel>
      <Panel
        id="location-inventory-title"
        title={t('adminUi.inventoryTitle')}
        flush
        actions={(
          <button className="btn btn-ghost btn-sm" disabled={task.busy} onClick={() => void task.run(async () => setInventory((await api.get<Inventory>('/admin/location/assets/inventory')).data))}>
            <HardDrive size={15} aria-hidden="true" />{t('location.inventoryRead')}
          </button>
        )}
      >
        {inventory ? (
          <div className="admin-table-scroll">
            <table>
              <thead><tr><th>{t('location.assetState')}</th><th>{t('location.metricCount')}</th><th>MiB</th></tr></thead>
              <tbody>
                {ASSET_STATES.map(state => {
                  const items = inventory.items.filter(item => item.state === state);
                  return <tr key={state}><td>{t(`location.assetState_${state}`)}</td><td className="admin-num">{items.length}</td><td className="admin-num">{(items.reduce((sum, item) => sum + item.bytes, 0) / 1048576).toFixed(2)}</td></tr>;
                })}
              </tbody>
            </table>
          </div>
        ) : <p className="admin-empty">—</p>}
      </Panel>
    </div>
  );
}
