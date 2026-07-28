import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../../api/client';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../ConfirmDialog';
import { toast } from '../Toast';

interface SpecialThanksItem {
  id: number;
  name: string;
  note: string;
}

export default function AdminSpecialThanks() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [items, setItems] = useState<SpecialThanksItem[]>([]);
  const [name, setName] = useState('');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await api.get<{ items: SpecialThanksItem[] }>('/special-thanks');
      setItems(response.data.items);
    } catch (error) {
      toast.error(errMsg(error));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const add = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      const response = await api.post<{ created: boolean }>('/admin/special-thanks', {
        name: trimmed,
        note: note.trim(),
      });
      setName('');
      setNote('');
      toast.success(t(response.data.created ? 'admin.thanksAdded' : 'admin.thanksAlreadyListed'));
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setSaving(false);
    }
  };

  const remove = async (item: SpecialThanksItem) => {
    if (!await confirm({
      title: t('admin.deleteThanksTitle', { name: item.name }),
      message: t('admin.deleteThanksMessage'),
      confirmLabel: t('admin.deleteThanksConfirm'),
      tone: 'danger',
    })) return;
    try {
      await api.delete(`/admin/special-thanks/${item.id}`);
      toast.success(t('admin.thanksDeleted'));
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    }
  };

  return (
    <div className="card admin-thanks-card">
      <h3>{t('admin.thanksTitle')}</h3>
      <div className="admin-thanks-form">
        <input
          className="input"
          maxLength={80}
          placeholder={t('admin.thanksNamePlaceholder')}
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
        <textarea
          className="input"
          rows={2}
          maxLength={200}
          placeholder={t('admin.thanksNotePlaceholder')}
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
        <button className="btn btn-success" disabled={!name.trim() || saving} onClick={() => void add()}>
          {saving ? t('admin.thanksAdding') : t('admin.addThanks')}
        </button>
      </div>
      <div className="admin-thanks-list">
        {!items.length && <p className="muted">{t('admin.noThanks')}</p>}
        {items.map((item) => (
          <div className="admin-thanks-row" key={item.id}>
            <span>
              <strong>{item.name}</strong>
              {item.note && <small>{item.note}</small>}
            </span>
            <button className="btn btn-danger btn-sm" onClick={() => void remove(item)}>
              {t('admin.deleteThanksConfirm')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
