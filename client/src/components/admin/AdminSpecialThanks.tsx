import { useCallback, useEffect, useState } from 'react';
import { api, errMsg } from '../../api/client';
import { useTranslation } from 'react-i18next';
import { useConfirm } from '../ConfirmDialog';
import { toast } from '../Toast';
import { ArrowDown, ArrowUp, Pencil, Trash2, X } from 'lucide-react';

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
  const [editingId, setEditingId] = useState<number | null>(null);
  const [reordering, setReordering] = useState(false);

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

  const resetForm = () => {
    setEditingId(null);
    setName('');
    setNote('');
  };

  const save = async () => {
    const trimmed = name.trim();
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      if (editingId != null) {
        await api.patch(`/admin/special-thanks/${editingId}`, { name: trimmed, note: note.trim() });
        toast.success(t('admin.thanksUpdated'));
      } else {
        const response = await api.post<{ created: boolean }>('/admin/special-thanks', {
          name: trimmed,
          note: note.trim(),
        });
        toast.success(t(response.data.created ? 'admin.thanksAdded' : 'admin.thanksAlreadyListed'));
      }
      resetForm();
      await load();
    } catch (error) {
      toast.error(errMsg(error));
    } finally {
      setSaving(false);
    }
  };

  const edit = (item: SpecialThanksItem) => {
    setEditingId(item.id);
    setName(item.name);
    setNote(item.note);
  };

  const move = async (index: number, offset: -1 | 1) => {
    const target = index + offset;
    if (reordering || target < 0 || target >= items.length) return;
    const previous = items;
    const next = [...items];
    [next[index], next[target]] = [next[target], next[index]];
    setItems(next);
    setReordering(true);
    try {
      await api.put('/admin/special-thanks/order', { ids: next.map((item) => item.id) });
      toast.success(t('admin.thanksOrderSaved'));
    } catch (error) {
      setItems(previous);
      toast.error(errMsg(error));
    } finally {
      setReordering(false);
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
      if (editingId === item.id) resetForm();
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
        <div className="admin-thanks-form-actions">
          {editingId != null && (
            <button
              type="button"
              className="btn btn-ghost"
              title={t('admin.cancelThanksEdit')}
              aria-label={t('admin.cancelThanksEdit')}
              onClick={resetForm}
            >
              <X size={16} />
            </button>
          )}
          <button className="btn btn-success" disabled={!name.trim() || saving} onClick={() => void save()}>
            {saving
              ? t('admin.thanksAdding')
              : editingId != null ? t('admin.saveThanksEdit') : t('admin.addThanks')}
          </button>
        </div>
      </div>
      <div className="admin-thanks-list">
        {!items.length && <p className="muted">{t('admin.noThanks')}</p>}
        {items.map((item, index) => (
          <div className="admin-thanks-row" key={item.id}>
            <span>
              <strong>{item.name}</strong>
              {item.note && <small>{item.note}</small>}
            </span>
            <div className="admin-thanks-row-actions">
              <button
                className="btn btn-ghost btn-sm"
                title={t('admin.editThanks', { name: item.name })}
                aria-label={t('admin.editThanks', { name: item.name })}
                onClick={() => edit(item)}
              >
                <Pencil size={15} />
              </button>
              <button
                className="btn btn-ghost btn-sm"
                title={t('admin.moveThanksUp', { name: item.name })}
                aria-label={t('admin.moveThanksUp', { name: item.name })}
                disabled={index === 0 || reordering}
                onClick={() => void move(index, -1)}
              >
                <ArrowUp size={15} />
              </button>
              <button
                className="btn btn-ghost btn-sm"
                title={t('admin.moveThanksDown', { name: item.name })}
                aria-label={t('admin.moveThanksDown', { name: item.name })}
                disabled={index === items.length - 1 || reordering}
                onClick={() => void move(index, 1)}
              >
                <ArrowDown size={15} />
              </button>
              <button
                className="btn btn-danger btn-sm"
                title={t('admin.deleteThanksEntry', { name: item.name })}
                aria-label={t('admin.deleteThanksEntry', { name: item.name })}
                onClick={() => void remove(item)}
              >
                <Trash2 size={15} />
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
