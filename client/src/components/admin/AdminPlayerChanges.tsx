import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, ChevronLeft, ChevronRight, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, errMsg } from '../../api/client';
import { currentLocale } from '../../i18n';
import Badge from '../Badge';
import DataTable, { type Column } from '../DataTable';
import { toast } from '../Toast';
import { useConfirm } from '../ConfirmDialog';

type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'conflict';

interface PlayerChangeItem {
  id: number;
  submissionId: number;
  playerId: number | null;
  playerNickname: string;
  field: string;
  oldValue: unknown;
  newValue: unknown;
  status: ChangeStatus;
  source: string;
  createdAt: string;
  handledAt: string | null;
  handledBy: string | null;
}

interface PlayerChangePage {
  items: PlayerChangeItem[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

function formatDate(value: string | null): string {
  if (!value) return '-';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '-' : date.toLocaleString(currentLocale());
}

export default function AdminPlayerChanges() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [items, setItems] = useState<PlayerChangeItem[]>([]);
  const [status, setStatus] = useState<'all' | ChangeStatus>('pending');
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<number>>(() => new Set());
  const selectAllRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<PlayerChangePage>('/admin/player-change-submissions', {
        params: { status, page, pageSize: 50, search: search || undefined },
      });
      setItems(response.data.items);
      setSelectedIds(new Set());
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

  const selectableItems = items.filter((item) => item.status === 'pending');
  const allVisibleSelected = selectableItems.length > 0
    && selectableItems.every((item) => selectedIds.has(item.id));
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = selectedIds.size > 0 && !allVisibleSelected;
    }
  }, [allVisibleSelected, selectedIds]);

  const toggleSelected = (id: number, checked: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  };
  const toggleAll = (checked: boolean) => {
    setSelectedIds(checked ? new Set(selectableItems.map((item) => item.id)) : new Set());
  };

  const review = async (decision: 'approve' | 'reject') => {
    const count = selectedIds.size;
    if (!count) return;
    const accepted = await confirm({
      title: t(decision === 'approve' ? 'admin.approvePlayerChangesTitle' : 'admin.rejectPlayerChangesTitle', { count }),
      message: t(decision === 'approve' ? 'admin.approvePlayerChangesMessage' : 'admin.rejectPlayerChangesMessage'),
      confirmLabel: t(decision === 'approve' ? 'admin.approveSelectedChanges' : 'admin.rejectSelectedChanges', { count }),
      tone: decision === 'approve' ? undefined : 'warning',
    });
    if (!accepted) return;
    setReviewing(true);
    try {
      const response = await api.post<{ approved: number; rejected: number; conflict: number }>(
        '/admin/player-change-submissions/review',
        { itemIds: [...selectedIds], decision }
      );
      toast.success(t('admin.playerChangesReviewed', response.data));
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setReviewing(false);
    }
  };

  const valueText = (value: unknown): string => {
    if (value === null || value === undefined || value === '') return t('admin.playerChangeEmptyValue');
    if (typeof value === 'boolean') return value ? t('admin.yes') : t('admin.no');
    if (Array.isArray(value)) return value.length ? value.join(', ') : t('admin.playerChangeEmptyValue');
    return String(value);
  };
  const statusLabel = (value: ChangeStatus) => t(`admin.playerChangeStatus.${value}`);
  const columns: Column<PlayerChangeItem>[] = [
    {
      key: 'selection',
      title: <input ref={selectAllRef} type="checkbox" aria-label={t('admin.selectAllPlayerChanges')} checked={allVisibleSelected} disabled={!selectableItems.length} onChange={(event) => toggleAll(event.target.checked)} />,
      render: (item) => <input type="checkbox" aria-label={t('admin.selectPlayerChange', { player: item.playerNickname, field: t(`admin.playerChangeFields.${item.field}`) })} checked={selectedIds.has(item.id)} disabled={item.status !== 'pending'} onChange={(event) => toggleSelected(item.id, event.target.checked)} />,
    },
    { key: 'playerNickname', title: t('admin.nickname') },
    { key: 'field', title: t('admin.playerChangeField'), render: (item) => t(`admin.playerChangeFields.${item.field}`) },
    { key: 'oldValue', title: t('admin.playerChangeOldValue'), render: (item) => <code>{valueText(item.oldValue)}</code> },
    { key: 'newValue', title: t('admin.playerChangeNewValue'), render: (item) => <code>{valueText(item.newValue)}</code> },
    { key: 'source', title: t('admin.playerChangeSource') },
    { key: 'createdAt', title: t('admin.playerChangeSubmittedAt'), render: (item) => formatDate(item.createdAt) },
    { key: 'status', title: t('admin.playerChangeStatusLabel'), render: (item) => <Badge text={statusLabel(item.status)} color={item.status === 'approved' ? 'green' : item.status === 'pending' ? 'amber' : 'gray'} /> },
    { key: 'handled', title: t('admin.playerChangeHandledBy'), render: (item) => item.handledBy ? `${item.handledBy} · ${formatDate(item.handledAt)}` : '-' },
  ];

  return <div className="card admin-users-card admin-player-changes-card">
    <div className="admin-players-header">
      <div className="admin-players-title"><h3>{t('admin.playerChangesTitle')}</h3><p className="muted">{t('admin.totalPlayerChanges', { count: total })}</p></div>
    </div>
    <div className="admin-list-toolbar">
      <label className="admin-search"><Search size={16} /><input className="input" value={searchInput} onChange={(event) => setSearchInput(event.target.value)} placeholder={t('admin.searchPlayerChanges')} /></label>
      <label className="admin-page-size"><span>{t('admin.playerChangeStatusLabel')}</span><select className="input" value={status} onChange={(event) => { setPage(1); setStatus(event.target.value as typeof status); }}><option value="pending">{statusLabel('pending')}</option><option value="approved">{statusLabel('approved')}</option><option value="rejected">{statusLabel('rejected')}</option><option value="conflict">{statusLabel('conflict')}</option><option value="all">{t('admin.playerChangeStatus.all')}</option></select></label>
      <button className="btn admin-player-change-action" type="button" disabled={!selectedIds.size || reviewing} onClick={() => void review('approve')}><Check size={16} />{t('admin.approveSelectedChanges', { count: selectedIds.size })}</button>
      <button className="btn btn-ghost admin-player-change-action" type="button" disabled={!selectedIds.size || reviewing} onClick={() => void review('reject')}><X size={16} />{t('admin.rejectSelectedChanges', { count: selectedIds.size })}</button>
    </div>
    <div className="admin-users-table admin-player-changes-table"><DataTable columns={columns} rows={items} rowKey={(item) => item.id} loading={loading} empty={t('admin.noPlayerChanges')} /></div>
    <div className="admin-pagination"><span className="muted">{total ? `${(page - 1) * 50 + 1}-${Math.min(page * 50, total)} / ${total}` : t('admin.zeroItems')}</span><div className="admin-pagination-actions"><button className="btn btn-ghost" type="button" aria-label={t('common.previousPage')} disabled={loading || page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}><ChevronLeft size={17} /></button><span>{t('admin.pageOf', { page, total: totalPages })}</span><button className="btn btn-ghost" type="button" aria-label={t('common.nextPage')} disabled={loading || page >= totalPages} onClick={() => setPage((value) => value + 1)}><ChevronRight size={17} /></button></div></div>
  </div>;
}
