import { useCallback, useEffect, useState } from 'react';
import { Megaphone, Plus } from 'lucide-react';
import { api, errMsg } from '../../api/client';
import { useConfirm } from '../ConfirmDialog';
import { toast } from '../Toast';
import { useTranslation } from 'react-i18next';
import { currentLocale } from '../../i18n';
import Badge from '../Badge';
import DataTable, { type Column } from '../DataTable';
import AdminDialog from './AdminDialog';
import { Panel, Toolbar, formatDateTime } from './ui';

interface Announcement {
  id: number;
  title: string;
  content: string;
  is_popup: boolean | number;
  created_at: string;
}

type Editing = { mode: 'create' } | { mode: 'edit'; item: Announcement };

/** 管理后台 - 公告管理：列表 + 添加 / 编辑对话框 */
export default function AdminAnnouncements() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const locale = currentLocale();
  const [items, setItems] = useState<Announcement[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Editing | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.get<Announcement[]>('/announcements');
      setItems(res.data);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (item: Announcement) => {
    if (!await confirm({
      title: t('admin.deleteAnnouncementTitle'),
      message: t('admin.deleteAnnouncementMessage'),
      confirmLabel: t('admin.deleteAnnouncementConfirm'),
      tone: 'danger',
    })) return;
    try {
      await api.delete(`/admin/announcements/${item.id}`);
      toast.success(t('admin.announcementDeleted'));
      await load();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const columns: Column<Announcement>[] = [
    {
      key: 'title',
      title: t('admin.announcementTitle'),
      render: (a) => <span className="admin-cell-stack"><strong>{a.title}</strong><small className="admin-cell-clamp">{a.content}</small></span>,
    },
    {
      key: 'type',
      title: t('adminUi.announcementType'),
      render: (a) => Boolean(a.is_popup) ? <Badge text={t('admin.popupAnnouncementBadge')} color="amber" /> : t('adminUi.normalAnnouncement'),
    },
    { key: 'created_at', title: t('adminUi.publishedAt'), render: (a) => formatDateTime(a.created_at, locale) },
    {
      key: 'actions',
      title: t('admin.actions'),
      render: (a) => (
        <span className="admin-row-actions">
          <button className="admin-action" type="button" onClick={() => setEditing({ mode: 'edit', item: a })}>{t('admin.edit')}</button>
          <button className="admin-action is-danger" type="button" onClick={() => void remove(a)}>{t('admin.deleteAnnouncementConfirm')}</button>
        </span>
      ),
    },
  ];

  return (
    <>
      <Panel flush className="admin-list-panel">
        <Toolbar
          end={(
            <button className="btn btn-sm" type="button" onClick={() => setEditing({ mode: 'create' })}>
              <Plus size={15} />{t('adminUi.addAnnouncement')}
            </button>
          )}
        >
          <span className="admin-toolbar-meta">{t('admin.announcementsTitle')} · {items.length}</span>
        </Toolbar>
        <div className="admin-table">
          <DataTable columns={columns} rows={items} rowKey={(a) => a.id} loading={loading} empty={t('adminUi.noAnnouncements')} />
        </div>
      </Panel>
      {editing && (
        <AnnouncementEditor
          key={editing.mode === 'edit' ? editing.item.id : 'new'}
          initial={editing.mode === 'edit' ? editing.item : null}
          onClose={() => setEditing(null)}
          onSaved={async () => { setEditing(null); await load(); }}
        />
      )}
    </>
  );
}

function AnnouncementEditor({ initial, onClose, onSaved }: {
  initial: Announcement | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const { t } = useTranslation();
  const [title, setTitle] = useState(initial?.title ?? '');
  const [content, setContent] = useState(initial?.content ?? '');
  const [isPopup, setIsPopup] = useState(Boolean(initial?.is_popup));
  const [saving, setSaving] = useState(false);
  const canSave = title.trim().length > 0 && content.trim().length > 0 && !saving;

  const save = async () => {
    if (!canSave) return;
    setSaving(true);
    try {
      const body = { title, content, is_popup: isPopup };
      if (initial) await api.put(`/admin/announcements/${initial.id}`, body);
      else await api.post('/admin/announcements', body);
      toast.success(initial ? t('adminUi.announcementUpdated') : t('admin.announcementPublished'));
      await onSaved();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <AdminDialog
      title={initial ? t('adminUi.editAnnouncement') : t('adminUi.addAnnouncement')}
      icon={<Megaphone size={18} aria-hidden="true" />}
      size="lg"
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-sm" type="submit" form="admin-announcement-form" disabled={!canSave}>
            {saving ? t('common.loading') : initial ? t('adminUi.saveChanges') : t('admin.publish')}
          </button>
        </>
      )}
    >
      <form id="admin-announcement-form" className="admin-form-stack" onSubmit={(event) => { event.preventDefault(); void save(); }}>
        <label className="admin-field">
          <span>{t('admin.announcementTitle')}</span>
          <input className="input" maxLength={128} value={title} onChange={(event) => setTitle(event.target.value)} />
        </label>
        <label className="admin-field">
          <span>{t('admin.announcementContent')}</span>
          <textarea className="input" rows={8} maxLength={10000} value={content} onChange={(event) => setContent(event.target.value)} />
        </label>
        <label className="admin-check">
          <input type="checkbox" checked={isPopup} onChange={(event) => setIsPopup(event.target.checked)} />
          <span>{t('admin.popupAnnouncement')}</span>
        </label>
        {initial && Boolean(initial.is_popup) && <p className="admin-help">{t('adminUi.editPopupHint')}</p>}
      </form>
    </AdminDialog>
  );
}
