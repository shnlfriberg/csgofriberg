import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Check, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, errMsg } from '../../api/client';
import { currentLocale } from '../../i18n';
import Badge from '../Badge';
import DataTable, { type Column } from '../DataTable';
import { toast } from '../Toast';
import { useConfirm } from '../ConfirmDialog';
import { Panel, Pagination, SearchBox, Segmented, Toolbar, formatDateTime } from './ui';

type ChangeStatus = 'pending' | 'approved' | 'rejected' | 'conflict';

interface PlayerChangeItem {
  id: number;
  submissionId: number;
  playerId: number | null;
  playerNickname: string;
  field: string;
  oldValue: unknown;
  observedValue?: unknown;
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

const PAGE_SIZE = 50;

export default function AdminPlayerChanges() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const locale = currentLocale();
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
        params: { status, page, pageSize: PAGE_SIZE, search: search || undefined },
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
  const statusColor = (value: ChangeStatus) => value === 'approved' ? 'green' : value === 'pending' ? 'amber' : 'gray';
  const columns: Column<PlayerChangeItem>[] = [
    {
      key: 'selection',
      title: <input ref={selectAllRef} type="checkbox" aria-label={t('admin.selectAllPlayerChanges')} checked={allVisibleSelected} disabled={!selectableItems.length} onChange={(event) => toggleAll(event.target.checked)} />,
      render: (item) => <input type="checkbox" aria-label={t('admin.selectPlayerChange', { player: item.playerNickname, field: t(`admin.playerChangeFields.${item.field}`) })} checked={selectedIds.has(item.id)} disabled={item.status !== 'pending'} onChange={(event) => toggleSelected(item.id, event.target.checked)} />,
    },
    {
      key: 'playerNickname',
      title: t('adminUi.playerColumn'),
      render: (item) => <span className="admin-cell-stack"><strong>{item.playerNickname}</strong><small>{t(`admin.playerChangeFields.${item.field}`)}</small></span>,
    },
    {
      key: 'change',
      title: t('adminUi.changeColumn'),
      render: (item) => (
        <span className="admin-diff">
          <code className="is-old" title={t('admin.playerChangeOldValue')}>{valueText(item.oldValue)}</code>
          <ArrowRight size={14} aria-hidden="true" />
          <code className="is-new" title={t('admin.playerChangeNewValue')}>{valueText(item.newValue)}</code>
          {item.observedValue !== undefined && (
            <small>{t('location.baselineObserved')}: {valueText(item.observedValue)}</small>
          )}
        </span>
      ),
    },
    {
      key: 'source',
      title: t('admin.playerChangeSource'),
      render: (item) => <span className="admin-cell-stack"><span>{item.source}</span><small>{formatDateTime(item.createdAt, locale)}</small></span>,
    },
    {
      key: 'status',
      title: t('admin.playerChangeStatusLabel'),
      render: (item) => (
        <span className="admin-cell-stack">
          <span><Badge text={statusLabel(item.status)} color={statusColor(item.status)} /></span>
          {item.handledBy && <small>{item.handledBy} · {formatDateTime(item.handledAt, locale)}</small>}
        </span>
      ),
    },
  ];

  return (
    <Panel flush className="admin-list-panel">
      <Toolbar
        end={(
          <>
            <span className="admin-selection" aria-live="polite">{t('adminUi.selectedCount', { count: selectedIds.size })}</span>
            <button className="btn btn-ghost btn-sm" type="button" disabled={!selectedIds.size || reviewing} onClick={() => void review('reject')}>
              <X size={15} />{t('admin.rejectSelectedChanges', { count: selectedIds.size })}
            </button>
            <button className="btn btn-sm" type="button" disabled={!selectedIds.size || reviewing} onClick={() => void review('approve')}>
              <Check size={15} />{t('admin.approveSelectedChanges', { count: selectedIds.size })}
            </button>
          </>
        )}
      >
        <Segmented
          label={t('admin.playerChangeStatusLabel')}
          value={status}
          onChange={(value) => { setPage(1); setStatus(value); }}
          options={[
            { value: 'pending', label: statusLabel('pending') },
            { value: 'approved', label: statusLabel('approved') },
            { value: 'rejected', label: statusLabel('rejected') },
            { value: 'conflict', label: statusLabel('conflict') },
            { value: 'all', label: t('admin.playerChangeStatus.all') },
          ]}
        />
        <SearchBox value={searchInput} onChange={setSearchInput} placeholder={t('admin.searchPlayerChanges')} />
        <span className="admin-toolbar-meta">{t('admin.totalPlayerChanges', { count: total })}</span>
      </Toolbar>
      <div className="admin-table admin-changes-table">
        <DataTable columns={columns} rows={items} rowKey={(item) => item.id} loading={loading} empty={t('admin.noPlayerChanges')} />
      </div>
      <Pagination page={page} pageSize={PAGE_SIZE} total={total} totalPages={totalPages} loading={loading} onPage={setPage} />
    </Panel>
  );
}
