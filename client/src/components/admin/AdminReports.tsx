import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, ChevronLeft, ChevronRight, Eye, Search, ShieldCheck, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, errMsg } from '../../api/client';
import { currentLocale } from '../../i18n';
import { difficultyLabel } from '../../utils/difficulty';
import Badge from '../Badge';
import DataTable, { type Column } from '../DataTable';
import ModalPortal from '../ModalPortal';
import { toast } from '../Toast';
import {
  GuestDetailDialog,
  UserDetailDialog,
  type AdminGuest,
  type AdminUser,
} from './AdminUsers';

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

function formatDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString(currentLocale());
}

export default function AdminReports() {
  const { t } = useTranslation();
  const [reports, setReports] = useState<MatchReport[]>([]);
  const [status, setStatus] = useState<'all' | ReportStatus>('pending');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<MatchReport | null>(null);
  const [reportedDetail, setReportedDetail] = useState<ReportedIdentity | null>(null);
  const [detailLoadingId, setDetailLoadingId] = useState<number | null>(null);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<ReportPage>('/admin/reports', {
        params: { status, page, pageSize: 50, search: search || undefined },
      });
      setReports(response.data.reports);
      setTotal(response.data.total);
      setTotalPages(response.data.totalPages);
      if (response.data.page !== page) setPage(response.data.page);
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setLoading(false);
    }
  }, [page, search, status]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

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

  const statusLabel = (value: ReportStatus) => t(`admin.reportStatus.${value}`);
  const columns: Column<MatchReport>[] = [
    { key: 'createdAt', title: t('admin.reportCreatedAt'), render: (report) => formatDate(report.createdAt) },
    { key: 'reporter', title: t('admin.reporter') },
    { key: 'reported', title: t('admin.reportedUser') },
    { key: 'match', title: t('admin.reportMatch'), render: (report) => `${difficultyLabel(t, report.mode)} · BO${report.boType}` },
    { key: 'description', title: t('admin.reportDescription'), render: (report) => report.description || t('admin.reportNoDescription') },
    {
      key: 'status',
      title: t('admin.reportStatusLabel'),
      render: (report) => <span className="admin-report-status"><Badge text={statusLabel(report.status)} color={report.status === 'pending' ? 'amber' : report.status === 'resolved' ? 'green' : 'gray'} />{report.whitelisted && <Badge text={t('admin.reportWhitelisted')} color="gray" />}</span>,
    },
    { key: 'actions', title: t('admin.actions'), render: (report) => <span className="admin-report-actions"><button className="btn btn-ghost btn-sm" type="button" disabled={detailLoadingId === report.id} onClick={() => void openReportedDetails(report)}><Eye size={15} />{detailLoadingId === report.id ? t('common.loading') : t('admin.viewReportedDetails')}</button><button className="btn btn-ghost btn-sm" type="button" onClick={() => setSelected(report)}><AlertTriangle size={15} />{t('admin.handleReport')}</button></span> },
  ];

  return <>
    <div className="card admin-users-card admin-reports-card">
      <div className="admin-players-header">
        <div className="admin-players-title"><h3>{t('admin.reportsTitle')}</h3><p className="muted">{t('admin.totalReports', { count: total })}</p></div>
      </div>
      <div className="admin-list-toolbar">
        <label className="admin-search"><Search size={16} /><input className="input" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={t('admin.searchReports')} /></label>
        <label className="admin-page-size"><span>{t('admin.reportStatusLabel')}</span><select className="input" value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as typeof status); }}><option value="pending">{statusLabel('pending')}</option><option value="resolved">{statusLabel('resolved')}</option><option value="dismissed">{statusLabel('dismissed')}</option><option value="all">{t('admin.reportStatus.all')}</option></select></label>
      </div>
      <div className="admin-users-table admin-reports-table"><DataTable columns={columns} rows={reports} rowKey={(report) => report.id} loading={loading} empty={t('admin.noReports')} /></div>
      <div className="admin-pagination"><span className="muted">{total ? `${(page - 1) * 50 + 1}-${Math.min(page * 50, total)} / ${total}` : t('admin.zeroItems')}</span><div className="admin-pagination-actions"><button className="btn btn-ghost" type="button" aria-label={t('common.previousPage')} disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button><span>{t('admin.pageOf', { page, total: totalPages })}</span><button className="btn btn-ghost" type="button" aria-label={t('common.nextPage')} disabled={loading || page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div></div>
    </div>
    {selected && <ReportDialog report={selected} onClose={() => setSelected(null)} onSaved={(updated, reload) => { if (reload) void load(); else setReports((current) => current.map((item) => item.id === updated.id ? updated : item)); setSelected(null); }} />}
    {reportedDetail?.type === 'user' && <UserDetailDialog user={reportedDetail.user} onClose={() => setReportedDetail(null)} onUserChange={(user) => setReportedDetail({ type: 'user', user })} />}
    {reportedDetail?.type === 'guest' && <GuestDetailDialog guest={reportedDetail.guest} onClose={() => setReportedDetail(null)} onGuestChange={(guest) => setReportedDetail({ type: 'guest', guest })} />}
  </>;
}

function ReportDialog({ report, onClose, onSaved }: { report: MatchReport; onClose: () => void; onSaved: (report: MatchReport, reload: boolean) => void }) {
  const { t } = useTranslation();
  const dialogRef = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const [status, setStatus] = useState<ReportStatus>(report.status);
  const [note, setNote] = useState(report.adminNote);
  const [saving, setSaving] = useState(false);
  const [applyToPending, setApplyToPending] = useState(false);
  const [whitelisting, setWhitelisting] = useState(false);
  useEffect(() => { onCloseRef.current = onClose; }, [onClose]);
  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    document.body.style.overflow = 'hidden';
    const frame = window.requestAnimationFrame(() => {
      const dialog = dialogRef.current;
      if (!dialog || (document.activeElement instanceof Node && dialog.contains(document.activeElement))) return;
      dialog.querySelector<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])')?.focus();
    });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onCloseRef.current(); return; }
      if (event.key !== 'Tab') return;
      const focusable = dialogRef.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [href], [tabindex]:not([tabindex="-1"])');
      if (!focusable?.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      window.cancelAnimationFrame(frame);
      document.body.style.overflow = oldOverflow;
      document.removeEventListener('keydown', onKeyDown);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, []);
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
  return <ModalPortal><div className="admin-player-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><div ref={dialogRef} className="admin-player-dialog admin-report-dialog" role="dialog" aria-modal="true" aria-labelledby="admin-report-title" tabIndex={-1}>
    <div className="admin-player-dialog-heading"><div><h2 id="admin-report-title"><AlertTriangle size={20} />{t('admin.handleReport')}</h2><p>{report.reporter} → {report.reported}</p></div><button className="confirm-close" type="button" aria-label={t('common.close')} onClick={onClose}><X size={18} /></button></div>
    <div className="admin-report-detail">
      <dl><div><dt>{t('admin.reportMatch')}</dt><dd>{difficultyLabel(t, report.mode)} · BO{report.boType} · #{report.matchId}</dd></div><div><dt>{t('admin.reportCreatedAt')}</dt><dd>{formatDate(report.createdAt)}</dd></div><div><dt>{t('admin.reportDescription')}</dt><dd>{report.description || t('admin.reportNoDescription')}</dd></div></dl>
      {report.whitelisted && <p className="admin-report-whitelist-state"><ShieldCheck size={17} />{t('admin.reportWhitelisted')}</p>}
      <label><span>{t('admin.reportStatusLabel')}</span><select className="input" value={status} onChange={(event) => setStatus(event.target.value as ReportStatus)}><option value="pending">{t('admin.reportStatus.pending')}</option><option value="resolved">{t('admin.reportStatus.resolved')}</option><option value="dismissed">{t('admin.reportStatus.dismissed')}</option></select></label>
      <label><span>{t('admin.reportAdminNote')}</span><textarea className="input" rows={4} maxLength={500} value={note} onChange={(event) => setNote(event.target.value)} placeholder={t('admin.reportAdminNotePlaceholder')} /></label>
      {report.pendingForReported > 1 && <label className="admin-report-batch-toggle"><input type="checkbox" checked={applyToPending} onChange={(event) => setApplyToPending(event.target.checked)} /><span>{t('admin.reportBatchSameReported', { count: report.pendingForReported })}</span></label>}
      <div className="confirm-actions"><button className="btn btn-ghost" type="button" onClick={onClose}>{t('common.cancel')}</button><button className="btn btn-ghost" type="button" disabled={saving || whitelisting} onClick={() => void (report.whitelisted ? removeFromWhitelist() : addToWhitelist())}><ShieldCheck size={16} />{whitelisting ? t('common.loading') : report.whitelisted ? t('admin.removeReportWhitelist') : t('admin.addReportWhitelist')}</button><button className="btn" type="button" disabled={saving || whitelisting} onClick={() => void save()}>{saving ? t('common.loading') : applyToPending ? t('admin.saveReportBatch') : t('admin.saveReport')}</button></div>
    </div>
  </div></div></ModalPortal>;
}
