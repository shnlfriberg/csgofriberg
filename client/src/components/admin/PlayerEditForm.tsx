import { FormEvent, useEffect, useId, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { PLAYER_ROLE_OPTIONS } from '../../utils/playerRoles';
import ModalPortal from '../ModalPortal';
import { toast } from '../Toast';
import { useTranslation } from 'react-i18next';
import DifficultyMultiSelect from './DifficultyMultiSelect';

export interface PlayerForm {
  id?: number;
  nickname: string;
  nationality: string;
  region: string;
  team: string;
  age: number;
  role: string;
  major_championships: number;
  major_appearances: number;
  difficulties: string[];
  is_active: boolean;
  is_enabled: boolean;
}

export const emptyPlayer: PlayerForm = {
  nickname: '',
  nationality: '',
  region: '',
  team: '',
  age: 25,
  role: 'Rifler',
  major_championships: 0,
  major_appearances: 0,
  difficulties: ['normal'],
  is_active: true,
  is_enabled: true,
};

interface Props {
  initial: PlayerForm;
  difficultyKeys: string[];
  onSubmit: (form: PlayerForm) => Promise<void>;
  onCancel: () => void;
}

export default function PlayerEditForm({ initial, difficultyKeys, onSubmit, onCancel }: Props) {
  const { t } = useTranslation();
  const [form, setForm] = useState<PlayerForm>(initial);
  const [saving, setSaving] = useState(false);
  const titleId = useId();
  const firstInputRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<PlayerForm>) => setForm((current) => ({ ...current, ...patch }));

  useEffect(() => {
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    firstInputRef.current?.focus();
    return () => {
      document.body.style.overflow = oldOverflow;
    };
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !saving) onCancel();
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [onCancel, saving]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaving(true);
    try {
      await onSubmit(form);
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('admin.saveFailed'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <ModalPortal>
      <div
        className="admin-player-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !saving) onCancel();
        }}
      >
        <div className="admin-player-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
          <div className="admin-player-dialog-heading">
            <div>
              <h2 id={titleId}>{form.id ? t('admin.editPlayer', { player: form.nickname }) : t('admin.addPlayer')}</h2>
              <p>{t('admin.formDescription')}</p>
            </div>
            <button className="confirm-close" type="button" aria-label={t('common.close')} onClick={onCancel} disabled={saving}>
              <X size={18} />
            </button>
          </div>

          <form onSubmit={submit}>
          <div className="admin-player-form-grid">
            <label className="admin-player-field">
              <span>{t('admin.playerNickname')}</span>
              <input ref={firstInputRef} className="input" value={form.nickname} onChange={(event) => set({ nickname: event.target.value })} required />
            </label>
            <label className="admin-player-field">
              <span>{t('admin.nationalityRequired')}</span>
              <input className="input" value={form.nationality} onChange={(event) => set({ nationality: event.target.value })} required />
            </label>
            <label className="admin-player-field">
              <span>{t('admin.region')}</span>
              <input className="input" value={form.region} onChange={(event) => set({ region: event.target.value })} placeholder={t('admin.regionPlaceholder')} />
            </label>
            <label className="admin-player-field">
              <span>{t('admin.currentTeam')}</span>
              <input className="input" value={form.team} onChange={(event) => set({ team: event.target.value })} />
            </label>
            <label className="admin-player-field">
              <span>{t('admin.ageRequired')}</span>
              <input className="input" type="number" min="10" max="100" value={form.age} onChange={(event) => set({ age: Number(event.target.value) })} required />
            </label>
            <label className="admin-player-field">
              <span>{t('admin.playerRole')}</span>
              <select className="input" value={form.role} onChange={(event) => set({ role: event.target.value })}>
                {PLAYER_ROLE_OPTIONS.map(({ value, labelKey }) => <option key={value} value={value}>{t(labelKey)}</option>)}
              </select>
            </label>
            <label className="admin-player-field">
              <span>{t('player.majorChampionships')}</span>
              <input className="input" type="number" min="0" value={form.major_championships} onChange={(event) => set({ major_championships: Number(event.target.value) })} />
            </label>
            <label className="admin-player-field">
              <span>{t('admin.majorAppearances')}</span>
              <input className="input" type="number" min="0" value={form.major_appearances} onChange={(event) => set({ major_appearances: Number(event.target.value) })} />
            </label>
          </div>

          <div className="admin-player-flags">
            <div className="admin-player-difficulty-field">
              <span className="admin-player-flag-label">{t('admin.difficulties')}</span>
              <DifficultyMultiSelect
                options={difficultyKeys}
                value={form.difficulties}
                onChange={(difficulties) => set({ difficulties })}
              />
            </div>
            <label><input type="checkbox" checked={form.is_active} onChange={(event) => set({ is_active: event.target.checked })} />{t('admin.activePlayer')}</label>
            <label><input type="checkbox" checked={form.is_enabled} onChange={(event) => set({ is_enabled: event.target.checked })} />{t('admin.enabledPlayer')}</label>
          </div>

          <div className="admin-player-dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onCancel} disabled={saving}>{t('common.cancel')}</button>
            <button className="btn btn-green" disabled={saving || form.difficulties.length === 0}>{saving ? t('admin.saving') : form.id ? t('admin.saveChanges') : t('admin.addPlayer')}</button>
          </div>
          </form>
        </div>
      </div>
    </ModalPortal>
  );
}
