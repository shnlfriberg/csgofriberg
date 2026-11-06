import { useCallback, useEffect, useRef, useState } from 'react';
import { Download, FileJson, Plus, Upload } from 'lucide-react';
import DataTable, { Column } from '../DataTable';
import Badge from '../Badge';
import PlayerEditForm, { PlayerForm, emptyPlayer } from './PlayerEditForm';
import AdminDialog from './AdminDialog';
import { Panel, Pagination, SearchBox, Toolbar } from './ui';
import { api, errMsg } from '../../api/client';
import { useConfirm } from '../ConfirmDialog';
import { playerRoleLabel } from '../../utils/playerRoles';
import { clearPlayerListCache } from '../../api/playerList';
import { toast } from '../Toast';
import { useTranslation } from 'react-i18next';
import { difficultyLabel } from '../../utils/difficulty';
import { AVAILABLE_DIFFICULTIES } from '../../config/difficulties';
import { countryLabel, regionLabel } from '../../utils/playerGeography';

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

/** 管理后台 - 选手库(列表/新增/编辑/停用/删除/JSON 导入导出) */
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
  const [importOpen, setImportOpen] = useState(false);
  const [exporting, setExporting] = useState(false);
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
        team_history: p.team_history ?? [],
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
      const { id } = form;
      // The list response also contains read-only database metadata. Only send editable fields.
      const body: Omit<PlayerForm, 'id'> = {
        nickname: form.nickname,
        nationality: form.nationality,
        region: form.region,
        team: form.team,
        team_history: form.team_history,
        age: form.age,
        role: form.role,
        major_championships: form.major_championships,
        major_appearances: form.major_appearances,
        difficulties: form.difficulties,
        is_active: form.is_active,
        is_enabled: form.is_enabled,
      };
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

  const doExport = async () => {
    setExporting(true);
    try {
      const res = await api.get<PlayerForm[]>('/admin/players/export');
      const blob = new Blob([`${JSON.stringify(res.data, null, 2)}\n`], {
        type: 'application/json;charset=utf-8',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'players.json';
      document.body.appendChild(link);
      try {
        link.click();
      } finally {
        link.remove();
        URL.revokeObjectURL(url);
      }
      toast.success(t('admin.exportDone', { count: res.data.length }));
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setExporting(false);
    }
  };

  const columns: Column<AdminPlayer>[] = [
    {
      key: 'nickname',
      title: t('adminUi.playerColumn'),
      render: (p) => <span className="admin-cell-stack"><strong>{p.nickname}</strong><small>{p.team || '—'}</small></span>,
    },
    {
      key: 'geo',
      title: t('adminUi.geoColumn'),
      render: (p) => <span className="admin-cell-stack"><span>{countryLabel(t, p.nationality)}</span><small>{regionLabel(t, p.region)}</small></span>,
    },
    { key: 'role', title: t('admin.role'), render: (p) => playerRoleLabel(p.role) },
    { key: 'age', title: t('admin.age') },
    { key: 'major', title: t('adminUi.majorColumn'), render: (p) => <span className="admin-num">{p.major_championships} / {p.major_appearances}</span> },
    { key: 'difficulties', title: t('admin.difficulties'), render: (p) => p.difficulties.map((key) => difficultyLabel(t, key)).join(' · ') || '—' },
    {
      key: 'status',
      title: t('adminUi.statusColumn'),
      render: (p) => (
        <span className="admin-badges">
          <Badge text={p.is_enabled ? t('admin.available') : t('admin.disabled')} color={p.is_enabled ? 'green' : 'gray'} />
          {!p.is_active && <Badge text={t('common.retired')} color="gray" />}
        </span>
      ),
    },
    {
      key: 'actions',
      title: t('admin.actions'),
      render: (p) => (
        <span className="admin-row-actions">
          <button type="button" className="admin-action" onClick={() => setEditing(p)}>{t('admin.edit')}</button>
          <button type="button" className="admin-action" onClick={() => void setEnabled(p, !p.is_enabled)}>
            {p.is_enabled ? t('admin.disable') : t('admin.enable')}
          </button>
          <button
            type="button"
            className="admin-action is-danger"
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
      <Panel flush className="admin-list-panel">
        <Toolbar
          end={(
            <>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => setImportOpen(true)}>
                <Upload size={15} />
                {t('adminUi.importJson')}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => void doExport()} disabled={exporting}>
                <Download size={15} />
                {exporting ? t('admin.exporting') : t('admin.exportAction')}
              </button>
              <button type="button" className="btn btn-sm" onClick={() => setEditing({ ...emptyPlayer })}>
                <Plus size={15} />
                {t('admin.addPlayer')}
              </button>
            </>
          )}
        >
          <SearchBox value={searchInput} onChange={setSearchInput} placeholder={t('admin.searchPlayers')} />
          <span className="admin-toolbar-meta">{t('admin.totalPlayers', { count: total })}</span>
        </Toolbar>
        <div className="admin-table admin-players-table">
          <DataTable
            columns={columns}
            rows={players}
            rowKey={(p) => p.id}
            loading={loading}
            empty={search ? t('admin.noMatchPlayers') : t('admin.noPlayers')}
          />
        </div>
        <Pagination
          page={page}
          pageSize={pageSize}
          total={total}
          totalPages={Math.ceil(total / pageSize)}
          loading={loading}
          onPage={setPage}
          onPageSize={(size) => { setPage(1); setPageSize(size); }}
        />
      </Panel>
      {importOpen && (
        <PlayerImportDialog
          onClose={() => setImportOpen(false)}
          onImported={async () => {
            setImportOpen(false);
            if (page !== 1) setPage(1);
            else await load();
          }}
        />
      )}
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

function PlayerImportDialog({ onClose, onImported }: { onClose: () => void; onImported: () => Promise<void> }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState('');

  const readFile = async (file: File | undefined) => {
    if (!file) return;
    setFileName(file.name);
    setText(await file.text());
  };

  const submit = async () => {
    setBusy(true);
    try {
      const parsed = JSON.parse(text);
      const list = Array.isArray(parsed) ? parsed : parsed.players;
      const res = await api.post('/admin/players/import', { players: list });
      clearPlayerListCache();
      toast.success(t('admin.importDone', { created: res.data.created, updated: res.data.updated }));
      if (res.data.careerReviews) toast.success(t('card.careerView.importReviews', { count: res.data.careerReviews }));
      await onImported();
    } catch (err) {
      toast.error(err instanceof SyntaxError ? t('admin.jsonError') : errMsg(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <AdminDialog
      title={t('admin.importTitle')}
      icon={<FileJson size={18} aria-hidden="true" />}
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-sm" type="button" onClick={() => void submit()} disabled={busy || !text.trim()}>
            {busy ? t('common.loading') : t('admin.importAction')}
          </button>
        </>
      )}
    >
      <div className="admin-form-stack">
        <p className="admin-help">{t('admin.importDescription')}</p>
        <p className="admin-help">{t('card.careerView.exportNote')}</p>
        <label className="admin-file-pick">
          <input type="file" accept="application/json,.json" onChange={(event) => { void readFile(event.target.files?.[0]); event.target.value = ''; }} />
          <span className="btn btn-ghost btn-sm"><Upload size={15} />{t('adminUi.chooseFile')}</span>
          <span className="admin-file-name">{fileName || t('adminUi.orPaste')}</span>
        </label>
        <textarea
          className="input admin-code-input"
          rows={10}
          value={text}
          aria-label={t('admin.importTitle')}
          onChange={(event) => setText(event.target.value)}
          placeholder={t('admin.importPlaceholder')}
        />
      </div>
    </AdminDialog>
  );
}
