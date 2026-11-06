import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ShieldCheck, ShieldX } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, errMsg } from '../../api/client';
import { currentLocale } from '../../i18n';
import { difficultyLabel } from '../../utils/difficulty';
import Badge from '../Badge';
import DataTable, { type Column } from '../DataTable';
import { toast } from '../Toast';
import { useConfirm } from '../ConfirmDialog';
import {
  GuestDetailDialog,
  UserDetailDialog,
  type AdminGuest,
  type AdminUser,
} from './AdminUsers';
import ExternalAnalysisPanel, { type ExternalAnalysisView } from './ExternalAnalysisPanel';
import AdminDialog from './AdminDialog';
import { FilterSelect, Panel, Pagination, SearchBox, Segmented, Toolbar, formatDateTime } from './ui';

type ReportStatus = 'pending' | 'resolved' | 'dismissed';

interface MatchReport {
  id: number;
  matchId: number;
  roomId: string;
  mode: string;
  boType: number;
  reporterKey: string;
  reportedKey: string;
  reporter: string;
  reported: string;
  description: string;
  status: ReportStatus;
  adminNote: string;
  createdAt: string;
  handledAt: string | null;
  matchCreatedAt: string;
  pendingForReported: number;
  pendingReporterCount: number;
  whitelisted: boolean;
}

interface ReportPage {
  reports: MatchReport[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

type ReportedIdentity =
  | { type: 'user'; user: AdminUser }
  | { type: 'guest'; guest: AdminGuest };

const PAGE_SIZE = 50;
const statusColor = (status: ReportStatus) => status === 'pending' ? 'amber' : status === 'resolved' ? 'green' : 'gray';

export default function AdminReports() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const locale = currentLocale();
  const [reports, setReports] = useState<MatchReport[]>([]);
  const [status, setStatus] = useState<'all' | ReportStatus>('pending');
  const [reporterFilter, setReporterFilter] = useState<'all' | 'multiple' | 'single'>('all');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MatchReport | null>(null);
  const [reportedDetail, setReportedDetail] = useState<ReportedIdentity | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null);
  const [quickBusy, setQuickBusy] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const [batchSelectedOpen, setBatchSelectedOpen] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<ReportPage>('/admin/reports', {
        params: { status, reporterFilter, page, pageSize: PAGE_SIZE, search: search || undefined },
      });
      setReports(response.data.reports);
      setSelectedIds(new Set());
      setTotal(response.data.total);
      setTotalPages(response.data.totalPages);
      if (response.data.page !== page) setPage(response.data.page);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, [page, reporterFilter, search, status]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const allVisibleSelected = reports.length > 0 && reports.every((report) => selectedIds.has(report.id));
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedIds.size > 0 && !allVisibleSelected;
    }
  }, [allVisibleSelected, selectedIds]);

  const toggleSelected = (reportId: number, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(reportId);
      else next.delete(reportId);
      return next;
    });
  };
  const toggleAllVisible = (checked: boolean) => {
    setSelectedIds(checked ? new Set(reports.map((report) => report.id)) : new Set());
  };

  const openReportedDetails = async (report: MatchReport) => {
    setDetailLoadingId(report.id);
    try {
      const response = await api.get<ReportedIdentity>(`/admin/reports/${report.id}/reported-identity`);
      setReportedDetail(response.data);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setDetailLoadingId(null);
    }
  };

  const quickDismissSingleReporter = async () => {
    if (!reports.length) {
      toast.info(t('admin.quickActionNoReports'));
      return;
    }
    if (!await confirm({
      title: t('admin.quickDismissSingleTitle'),
      message: t('admin.quickDismissSingleMessage'),
      confirmLabel: t('admin.quickDismissSingleReporter'),
      tone: 'warning',
    })) return;
    setQuickBusy(true);
    try {
      const response = await api.post<{ targetCount: number; updated: number }>(
        '/admin/reports/quick-dismiss/single-reporter',
        { adminNote: t('admin.quickDismissSingleNote'), reportedKeys: [...new Set(reports.map((report) => report.reportedKey))] }
      );
      toast.success(t('admin.quickDismissSingleDone', { targets: response.data.targetCount, reports: response.data.updated }));
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setQuickBusy(false);
    }
  };

  const statusLabel = (value: ReportStatus) => t(`admin.reportStatus.${value}`);
  const columns: Column<MatchReport>[] = [
    {
      key: 'selection',
      title: <input ref={selectAllRef} type="checkbox" aria-label={t('admin.selectAllReports')} checked={allVisibleSelected} disabled={!reports.length} onChange={(event) => toggleAllVisible(event.target.checked)} />,
      render: (report) => <input type="checkbox" aria-label={t('admin.selectReport', { reported: report.reported })} checked={selectedIds.has(report.id)} onChange={(event) => toggleSelected(report.id, event.target.checked)} />,
    },
    {
      key: 'reported',
      title: t('admin.reportedUser'),
      render: (report) => (
        <span className="admin-cell-stack">
          <strong>{report.reported}</strong>
          <small>
            {t('admin.reporter')}: {report.reporter}
            {report.pendingReporterCount > 0 && ` · ${t('admin.reportReporterCount', { count: report.pendingReporterCount })}`}
          </small>
        </span>
      ),
    },
    {
      key: 'match',
      title: t('admin.reportMatch'),
      render: (report) => <span className="admin-cell-stack"><span>{difficultyLabel(t, report.mode)} · BO{report.boType}</span><small>{formatDateTime(report.createdAt, locale)}</small></span>,
    },
    { key: 'description', title: t('admin.reportDescription'), render: (report) => <span className="admin-cell-clamp" title={report.description}>{report.description || t('admin.reportNoDescription')}</span> },
    {
      key: 'status',
      title: t('admin.reportStatusLabel'),
      render: (report) => (
        <span className="admin-badges">
          <Badge text={statusLabel(report.status)} color={statusColor(report.status)} />
          {report.whitelisted && <Badge text={t('admin.reportWhitelisted')} color="gray" />}
        </span>
      ),
    },
    {
      key: 'actions',
      title: t('admin.actions'),
      render: (report) => (
        <span className="admin-row-actions">
          <button className="admin-action" type="button" onClick={() => setSelected(report)}>{t('admin.handleReport')}</button>
          <button className="admin-action" type="button" aria-label={t('admin.viewReportedDetails')} title={t('admin.viewReportedDetails')} disabled={detailLoadingId === report.id} onClick={() => void openReportedDetails(report)}>
            {detailLoadingId === report.id ? t('common.loading') : t('admin.details')}
          </button>
        </span>
      ),
    },
  ];

  return <>
    <Panel flush className="admin-list-panel">
      <Toolbar
        end={(
          <>
            <button className="btn btn-ghost btn-sm" type="button" disabled={quickBusy} onClick={() => void quickDismissSingleReporter()} title={t('admin.quickDismissSingleMessage')}>
              <ShieldX size={15} />{quickBusy ? t('common.loading') : t('admin.quickDismissSingleReporter')}
            </button>
            <button className="btn btn-sm" type="button" disabled={!selectedIds.size} onClick={() => setBatchSelectedOpen(true)}>
              <ShieldCheck size={15} />{t('admin.processSelectedReports', { count: selectedIds.size })}
            </button>
          </>
        )}
      >
        <Segmented
          label={t('admin.reportStatusLabel')}
          value={status}
          onChange={(value) => { setPage(1); setStatus(value); }}
          options={[
            { value: 'pending', label: statusLabel('pending') },
            { value: 'resolved', label: statusLabel('resolved') },
            { value: 'dismissed', label: statusLabel('dismissed') },
            { value: 'all', label: t('admin.reportStatus.all') },
          ]}
        />
        <FilterSelect
          label={t('admin.reporterFilterLabel')}
          value={reporterFilter}
          onChange={(value) => { setPage(1); setReporterFilter(value); }}
          options={[
            { value: 'all', label: t('admin.reporterFilter.all') },
            { value: 'multiple', label: t('admin.reporterFilter.multiple') },
            { value: 'single', label: t('admin.reporterFilter.single') },
          ]}
        />
        <SearchBox value={searchInput} onChange={setSearchInput} placeholder={t('admin.searchReports')} />
        <span className="admin-toolbar-meta">{t('admin.totalReports', { count: total })}</span>
      </Toolbar>
      <div className="admin-table admin-reports-table">
        <DataTable columns={columns} rows={reports} rowKey={(report) => report.id} loading={loading} empty={t('admin.noReports')} />
      </div>
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} totalPages={totalPages} loading={loading} onPage={setPage} />
    </Panel>
    {selected && <ReportDialog report={selected} onClose={() => setSelected(null)} onSaved={(updated, reload) => { if (reload) void load(); else setReports((current) => current.map((item) => item.id === updated.id ? updated : item)); setSelected(null); }} />}
    {batchSelectedOpen && <BatchSelectedDialog reportIds={[...selectedIds]} onClose={() => setBatchSelectedOpen(false)} onSaved={() => { setBatchSelectedOpen(false); setSelectedIds(new Set()); void load(); }} />}
    {reportedDetail?.type === 'user' && <UserDetailDialog user={reportedDetail.user} onClose={() => setReportedDetail(null)} onUserChange={(user) => setReportedDetail({ type: 'user', user })} />}
    {reportedDetail?.type === 'guest' && <GuestDetailDialog guest={reportedDetail.guest} onClose={() => setReportedDetail(null)} onGuestChange={(guest) => setReportedDetail({ type: 'guest', guest })} />}
  </>;
}

function StatusAndNote({ status, onStatus, note, onNote }: { status: ReportStatus; onStatus: (status: ReportStatus) => void; note: string; onNote: (note: string) => void }) {
  const { t } = useTranslation();
  return <>
    <label className="admin-field"><span>{t('admin.reportStatusLabel')}</span>
      <select className="input" value={status} onChange={(event) => onStatus(event.target.value as ReportStatus)}>
        <option value="pending">{t('admin.reportStatus.pending')}</option>
        <option value="resolved">{t('admin.reportStatus.resolved')}</option>
        <option value="dismissed">{t('admin.reportStatus.dismissed')}</option>
      </select>
    </label>
    <label className="admin-field"><span>{t('admin.reportAdminNote')}</span>
      <textarea className="input" rows={3} maxLength={500} value={note} onChange={(event) => onNote(event.target.value)} placeholder={t('admin.reportAdminNotePlaceholder')} />
    </label>
  </>;
}

function BatchSelectedDialog({ reportIds, onClose, onSaved }: { reportIds: number[]; onClose: () => void; onSaved: () => void }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<ReportStatus>('resolved');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const response = await api.patch<{ updated: number }>('/admin/reports/batch-selected', {
        reportIds,
        status,
        adminNote: note.trim(),
      });
      toast.success(t('admin.selectedReportsHandled', { count: response.data.updated }));
      onSaved();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setSaving(false);
    }
  };
  return (
    <AdminDialog
      title={t('admin.processSelectedReports', { count: reportIds.length })}
      icon={<ShieldCheck size={19} aria-hidden="true" />}
      onClose={onClose}
      footer={<>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-sm" type="button" disabled={saving} onClick={() => void save()}>{saving ? t('common.loading') : t('admin.saveReportBatch')}</button>
      </>}
    >
      <div className="admin-form-stack">
        <StatusAndNote status={status} onStatus={setStatus} note={note} onNote={setNote} />
      </div>
    </AdminDialog>
  );
}

function ReportDialog({ report, onClose, onSaved }: { report: MatchReport; onClose: () => void; onSaved: (report: MatchReport, reload: boolean) => void }) {
  const { t } = useTranslation();
  const locale = currentLocale();
  const [status, setStatus] = useState<ReportStatus>(report.status);
  const [note, setNote] = useState(report.adminNote);
  const [saving, setSaving] = useState(false);
  const [applyToPending, setApplyToPending] = useState(false);
  const [whitelisting, setWhitelisting] = useState(false);
  const [analysis, setAnalysis] = useState<ExternalAnalysisView | null>(null);
  const [analysisLoading, setAnalysisLoading] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const adminNote = note.trim();
      if (applyToPending) {
        const response = await api.patch<{ updated: number }>('/admin/reports/batch', { reportedKey: report.reportedKey, status, adminNote });
        onSaved({ ...report, status, adminNote, handledAt: status === 'pending' ? null : new Date().toISOString() }, true);
        toast.success(t('admin.reportBatchHandled', { count: response.data.updated }));
      } else {
        await api.patch(`/admin/reports/${report.id}`, { status, adminNote });
        onSaved({ ...report, status, adminNote, handledAt: status === 'pending' ? null : new Date().toISOString() }, false);
        toast.success(t('admin.reportHandled'));
      }
    } catch (error) { toast.error(errMsg(error)); }
    finally { setSaving(false); }
  };
  const addToWhitelist = async () => {
    setWhitelisting(true);
    try {
      const adminNote = note.trim();
      const response = await api.post<{ dismissed: number }>('/admin/reports/whitelist', { reportedKey: report.reportedKey, adminNote });
      onSaved({
        ...report,
        status: report.status === 'pending' ? 'dismissed' : report.status,
        adminNote,
        handledAt: report.status === 'pending' ? new Date().toISOString() : report.handledAt,
        pendingForReported: 0,
        whitelisted: true,
      }, true);
      toast.success(t('admin.reportWhitelistedAdded', { count: response.data.dismissed }));
    } catch (error) { toast.error(errMsg(error)); }
    finally { setWhitelisting(false); }
  };
  const removeFromWhitelist = async () => {
    setWhitelisting(true);
    try {
      await api.delete(`/admin/reports/whitelist/${encodeURIComponent(report.reportedKey)}`);
      onSaved({ ...report, whitelisted: false }, true);
      toast.success(t('admin.reportWhitelistedRemoved'));
    } catch (error) { toast.error(errMsg(error)); }
    finally { setWhitelisting(false); }
  };
  const runAnalysis = async (analysisLocale: string) => {
    setAnalysisLoading(true);
    try {
      const response = await api.post<ExternalAnalysisView>(`/admin/reports/${report.id}/analysis`, { locale: analysisLocale });
      setAnalysis(response.data);
    } catch (error) { toast.error(errMsg(error)); }
    finally { setAnalysisLoading(false); }
  };
  return (
    <AdminDialog
      title={t('admin.handleReport')}
      icon={<AlertTriangle size={19} aria-hidden="true" />}
      subtitle={`${report.reporter} → ${report.reported}`}
      size="lg"
      onClose={onClose}
      className="admin-report-dialog"
      footer={<>
        <button className="btn btn-ghost btn-sm admin-foot-start" type="button" disabled={saving || whitelisting} onClick={() => void (report.whitelisted ? removeFromWhitelist() : addToWhitelist())}>
          <ShieldCheck size={15} />{whitelisting ? t('common.loading') : report.whitelisted ? t('admin.removeReportWhitelist') : t('admin.addReportWhitelist')}
        </button>
        <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>{t('common.cancel')}</button>
        <button className="btn btn-sm" type="button" disabled={saving || whitelisting} onClick={() => void save()}>{saving ? t('common.loading') : applyToPending ? t('admin.saveReportBatch') : t('admin.saveReport')}</button>
      </>}
    >
      <div className="admin-form-stack">
        <dl className="admin-kv">
          <dt>{t('admin.reportMatch')}</dt><dd>{difficultyLabel(t, report.mode)} · BO{report.boType} · #{report.matchId}</dd>
          <dt>{t('admin.reportCreatedAt')}</dt><dd>{formatDateTime(report.createdAt, locale)}</dd>
          <dt>{t('admin.reportDescription')}</dt><dd>{report.description || t('admin.reportNoDescription')}</dd>
        </dl>
        {report.whitelisted && <p className="admin-report-whitelist-state"><ShieldCheck size={17} />{t('admin.reportWhitelisted')}</p>}
        <ExternalAnalysisPanel view={analysis} loading={analysisLoading} onAnalyze={(value) => void runAnalysis(value)} />
        <StatusAndNote status={status} onStatus={setStatus} note={note} onNote={setNote} />
        {report.pendingForReported > 1 && (
          <label className="admin-check">
            <input type="checkbox" checked={applyToPending} onChange={(event) => setApplyToPending(event.target.checked)} />
            <span>{t('admin.reportBatchSameReported', { count: report.pendingForReported })}</span>
          </label>
        )}
      </div>
    </AdminDialog>
  );
}
