import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../../location/api';
import { useConfirm } from '../../ConfirmDialog';
import { useAdminTask } from './useAdminTask';

type Job = { game_id: string; attempts: number; due_at: number; last_error: string | null };
type Metrics = { instance: string; rssBytes: number; collectedAt: string; counters: Record<string, number>;
  timings: Record<string, { count: number; meanMs: number; p95Ms: number }>; outbox: { pending: number; deadLetters: number } };
export default function Operations({ active }: { active: boolean }) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const task = useAdminTask();
  const [metrics, setMetrics] = useState<Metrics>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [inventory, setInventory] = useState<{ items: Array<{ url: string; bytes: number; state: string }> }>();
  const load = async () => {
    const [stats, queue] = await Promise.all([api.get<Metrics>('/admin/location/metrics'), api.get<{ items: Job[] }>('/admin/location/outbox')]);
    setMetrics(stats.data); setJobs(queue.data.items);
  };
  useEffect(() => { if (active) void task.run(load); }, [active]);
  const retry = async (job: Job) => {
    if (!await confirm({ title: t('location.retrySettlement'), message: t('location.retrySettlementHelp'), confirmLabel: t('location.retrySettlement') })) return;
    await task.run(async () => { await api.post(`/admin/location/outbox/${encodeURIComponent(job.game_id)}/retry`); await load(); });
  };
  return <section>
    <p>{t('location.metricsScope')}</p>
    <button className="btn" disabled={task.busy} onClick={() => void task.run(load)}>{t('location.refreshOperations')}</button>
    {task.error && <p role="alert">{task.error}</p>}
    {metrics && <>
      <p>{t('location.instance')}: {metrics.instance} · RSS {(metrics.rssBytes / 1048576).toFixed(1)} MiB · {new Date(metrics.collectedAt).toLocaleString()}</p>
      <p>{t('location.pendingSettlements')}: {metrics.outbox.pending} · {t('location.deadLetters')}: {metrics.outbox.deadLetters}</p>
      <table><thead><tr><th>{t('location.metric')}</th><th>{t('location.metricCount')}</th><th>{t('location.meanMs')}</th><th>P95 ms</th></tr></thead><tbody>
        {Object.entries(metrics.timings).map(([name, row]) => <tr key={name}><td>{name}</td><td>{row.count}</td><td>{row.meanMs}</td><td>{row.p95Ms}</td></tr>)}
        {Object.entries(metrics.counters).map(([name, count]) => <tr key={name}><td>{name}</td><td>{count}</td><td>—</td><td>—</td></tr>)}
      </tbody></table>
    </>}
    <table><thead><tr><th>ID</th><th>{t('location.attempts')}</th><th>{t('location.dueAt')}</th><th>{t('location.lastError')}</th><th /></tr></thead><tbody>
      {jobs.map(job => <tr key={job.game_id}><td>{job.game_id}</td><td>{job.attempts}</td><td>{new Date(Number(job.due_at)).toLocaleString()}</td><td>{job.last_error || '—'}</td><td><button className="btn" disabled={task.busy} onClick={() => void retry(job)}>{t('location.retrySettlement')}</button></td></tr>)}
    </tbody></table>
    <button className="btn" disabled={task.busy} onClick={() => void task.run(async () => setInventory((await api.get('/admin/location/assets/inventory')).data))}>{t('location.inventoryRead')}</button>
    {inventory && <table><thead><tr><th>{t('location.assetState')}</th><th>{t('location.metricCount')}</th><th>MiB</th></tr></thead><tbody>
      {['referenced', 'staged', 'quarantine-candidate'].map(state => {
        const items = inventory.items.filter(item => item.state === state);
        return <tr key={state}><td>{t(`location.assetState_${state}`)}</td><td>{items.length}</td><td>{(items.reduce((sum, item) => sum + item.bytes, 0) / 1048576).toFixed(2)}</td></tr>;
      })}
    </tbody></table>}
  </section>;
}
