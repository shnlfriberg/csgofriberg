import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Plus, Search } from 'lucide-react';
import DataTable, { Column } from '../DataTable';
import PlayerEditForm, { PlayerForm, emptyPlayer } from './PlayerEditForm';
import { api, errMsg } from '../../api/client';
import { useConfirm } from '../ConfirmDialog';
import { playerRoleLabel } from '../../utils/playerRoles';
import { clearPlayerListCache } from '../../api/playerList';
import { toast } from '../Toast';
import { useTranslation } from 'react-i18next';
import { difficultyLabel } from '../../utils/difficulty';
import { AVAILABLE_DIFFICULTIES } from '../../config/difficulties';

interface AdminPlayer extends PlayerForm {
  id: number;
}

interface PlayerPage {
  players: AdminPlayer[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

/** 管理后台 - 选手管理(列表/新增/编辑/删除/JSON 导入) */
export default function AdminPlayers() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [players, setPlayers] = useState<AdminPlayer[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [searchInput, setSearchInput] = useState('');
  const [search, setSearch] = useState('');
  const [loading, setLoading] = useState(false);
  const [editing, setEditing] = useState<PlayerForm | null>(null);
  const [importText, setImportText] = useState('');
  const requestId = useRef(0);

  const load = useCallback(async () => {
    const currentRequest = ++requestId.current;
    setLoading(true);
    try {
      const res = await api.get<PlayerPage>('/admin/players', {
        params: { page, pageSize, search: search || undefined },
      });
      if (currentRequest !== requestId.current) return;
      setPlayers(res.data.players.map((p) => ({
        ...p,
        difficulties: p.difficulties ?? [],
        is_active: Boolean(p.is_active),
        is_enabled: Boolean(p.is_enabled),
      })));
      setTotal(res.data.total);
      if (res.data.page !== page) setPage(res.data.page);
    } catch (err) {
      if (currentRequest === requestId.current) toast.error(errMsg(err));
    } finally {
      if (currentRequest === requestId.current) setLoading(false);
    }
  }, [page, pageSize, search]);

  useEffect(() => {
    void load();
  }, [load]);


  useEffect(() => {
    const timer = window.setTimeout(() => {
      setPage(1);
      setSearch(searchInput.trim());
    }, 250);
    return () => window.clearTimeout(timer);
  }, [searchInput]);

  const save = async (form: PlayerForm) => {
    try {
      const { id, ...body } = form;
      if (id) {
        await api.put(`/admin/players/${id}`, body);
      } else {
        await api.post('/admin/players', body);
      }
      clearPlayerListCache();
      setEditing(null);
      toast.success(id ? t('admin.saved') : t('admin.added'));
      if (!id && page !== 1) setPage(1);
      else await load();
    } catch (err) {
      throw new Error(errMsg(err));
    }
  };

  const setEnabled = async (p: AdminPlayer, isEnabled: boolean) => {
    if (!isEnabled && !await confirm({
      title: t('admin.disableTitle', { player: p.nickname }),
      message: t('admin.disableMessage'),
      confirmLabel: t('admin.disableConfirm'),
      tone: 'warning',
    })) return;
    try {
      await api.put(`/admin/players/${p.id}`, { is_enabled: isEnabled });
      clearPlayerListCache();
      toast.success(isEnabled ? t('admin.enabledSuccess', { player: p.nickname }) : t('admin.disabledSuccess', { player: p.nickname }));
      await load();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const remove = async (p: AdminPlayer) => {
    if (!await confirm({
      title: t('admin.deleteTitle', { player: p.nickname }),
      message: t('admin.deleteMessage'),
      confirmLabel: t('admin.deleteConfirm'),
      tone: 'danger',
    })) return;
    try {
      await api.delete(`/admin/players/${p.id}`);
      clearPlayerListCache();
      toast.success(t('admin.deleted', { player: p.nickname }));
      await load();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const doImport = async () => {
    try {
      const parsed = JSON.parse(importText);
      const list = Array.isArray(parsed) ? parsed : parsed.players;
      const res = await api.post('/admin/players/import', { players: list });
      clearPlayerListCache();
      toast.success(t('admin.importDone', { created: res.data.created, updated: res.data.updated }));
      setImportText('');
      if (page !== 1) setPage(1);
      else await load();
    } catch (err) {
      toast.error(err instanceof SyntaxError ? t('admin.jsonError') : errMsg(err));
    }
  };

  const columns: Column<AdminPlayer>[] = [
    { key: 'nickname', title: t('admin.nickname') },
    { key: 'nationality', title: t('admin.nationality') },
    { key: 'region', title: t('admin.region') },
    { key: 'team', title: t('admin.team') },
    { key: 'age', title: t('admin.age') },
    { key: 'role', title: t('admin.role'), render: (p) => playerRoleLabel(p.role) },
    { key: 'major_championships', title: t('admin.majorTitles') },
    { key: 'major_appearances', title: t('admin.major') },
    { key: 'difficulties', title: t('admin.difficulties'), render: (p) => p.difficulties.map((key) => difficultyLabel(t, key)).join(', ') },
    { key: 'is_active', title: t('admin.status'), render: (p) => (p.is_active ? t('common.active') : t('common.retired')) },
    { key: 'is_enabled', title: t('admin.pool'), render: (p) => (p.is_enabled ? t('admin.available') : t('admin.disabled')) },
    {
      key: 'actions',
      title: t('admin.actions'),
      render: (p) => (
        <span className="admin-player-actions">
          <button type="button" className="btn btn-ghost" onClick={() => setEditing(p)}>{t('admin.edit')}</button>
          <button
            type="button"
            className="btn btn-ghost"
            onClick={() => void setEnabled(p, !p.is_enabled)}
          >
            {p.is_enabled ? t('admin.disable') : t('admin.enable')}
          </button>
          <button
            type="button"
            className="btn btn-red"
            onClick={() => void remove(p)}
            disabled={p.is_enabled}
            title={p.is_enabled ? t('admin.disableFirst') : t('admin.delete')}
          >
            {t('admin.delete')}
          </button>
        </span>
      ),
    },
  ];

  return (
    <>
      <div className="card admin-players-card">
        <div className="admin-players-header">
          <div className="admin-players-title">
            <h3>{t('admin.playersTitle')}</h3>
            <p className="muted">{t('admin.totalPlayers', { count: total })}</p>
          </div>
          <button
            type="button"
            className="btn btn-green admin-player-add"
            onClick={() => setEditing({ ...emptyPlayer })}
          >
            <Plus size={16} />
            {t('admin.addPlayer')}
          </button>
        </div>
        <div className="admin-list-toolbar">
          <label className="admin-search">
            <Search size={16} />
            <input
              className="input"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder={t('admin.searchPlayers')}
            />
          </label>
          <label className="admin-page-size">
            <span>{t('admin.pageSize')}</span>
            <select
              className="input"
              value={pageSize}
              onChange={(event) => {
                setPage(1);
                setPageSize(Number(event.target.value));
              }}
            >
              {[20, 50, 100].map((size) => <option key={size} value={size}>{size}</option>)}
            </select>
          </label>
        </div>
        <div className="admin-players-table">
          <DataTable
            columns={columns}
            rows={players}
            rowKey={(p) => p.id}
            empty={loading ? t('common.loading') : search ? t('admin.noMatchPlayers') : t('admin.noPlayers')}
          />
        </div>
        <div className="admin-pagination">
          <span className="muted">
            {total ? `${(page - 1) * pageSize + 1}-${Math.min(page * pageSize, total)} / ${total}` : t('admin.zeroItems')}
          </span>
          <div className="admin-pagination-actions">
            <button
              className="btn btn-ghost"
              aria-label={t('common.previousPage')}
              title={t('common.previousPage')}
              disabled={loading || page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              <ChevronLeft size={17} />
            </button>
            <span>{t('admin.pageOf', { page, total: Math.max(1, Math.ceil(total / pageSize)) })}</span>
            <button
              className="btn btn-ghost"
              aria-label={t('common.nextPage')}
              title={t('common.nextPage')}
              disabled={loading || page >= Math.max(1, Math.ceil(total / pageSize))}
              onClick={() => setPage((current) => current + 1)}
            >
              <ChevronRight size={17} />
            </button>
          </div>
        </div>
      </div>
      <div className="card admin-import-card">
        <h3>{t('admin.importTitle')}</h3>
        <p className="muted">
          {t('admin.importDescription')}
        </p>
        <textarea
          className="input"
          rows={6}
          value={importText}
          onChange={(e) => setImportText(e.target.value)}
          placeholder={t('admin.importPlaceholder')}
        />
        <button className="btn" style={{ marginTop: 8 }} onClick={() => void doImport()} disabled={!importText.trim()}>
          {t('admin.importAction')}
        </button>
      </div>
      {editing && (
        <PlayerEditForm
          key={editing.id ?? 'new'}
          initial={editing}
          difficultyKeys={AVAILABLE_DIFFICULTIES.map((item) => item.key)}
          onSubmit={save}
          onCancel={() => setEditing(null)}
        />
      )}
    </>
  );
}
