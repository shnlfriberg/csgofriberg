import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus, Trash2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, errMsg } from '../../api/client';
import { currentLocale } from '../../i18n';
import { useConfirm } from '../ConfirmDialog';
import { toast } from '../Toast';

interface ApiTokenItem {
  id: number;
  name: string;
  prefix: string;
  created_at: string;
  expires_at: string;
}

interface CreatedApiToken extends ApiTokenItem {
  token: string;
}

export default function AdminApiTokens() {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [tokens, setTokens] = useState<ApiTokenItem[]>([]);
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('90');
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [copied, setCopied] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await api.get<{ tokens: ApiTokenItem[] }>('/admin/api-tokens');
      setTokens(response.data.tokens);
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const create = async () => {
    const days = Number(expiresInDays);
    if (!name.trim() || !Number.isInteger(days) || days < 1 || days > 365) return;
    setSubmitting(true);
    try {
      const response = await api.post<CreatedApiToken>('/admin/api-tokens', {
        name: name.trim(),
        expiresInDays: days,
      });
      setCreated(response.data);
      setName('');
      setCopied(false);
      toast.success(t('admin.apiTokenCreated'));
      await load();
    } catch (err) {
      toast.error(errMsg(err));
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async () => {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.token);
      setCopied(true);
      toast.success(t('admin.apiTokenCopied'));
    } catch {
      toast.error(t('admin.apiTokenCopyFailed'));
    }
  };

  const revoke = async (token: ApiTokenItem) => {
    const accepted = await confirm({
      title: t('admin.revokeApiTokenTitle', { name: token.name }),
      message: t('admin.revokeApiTokenMessage'),
      confirmLabel: t('admin.revokeApiToken'),
      tone: 'danger',
    });
    if (!accepted) return;
    try {
      await api.delete(`/admin/api-tokens/${token.id}`);
      toast.success(t('admin.apiTokenRevoked'));
      await load();
    } catch (err) {
      toast.error(errMsg(err));
    }
  };

  const days = Number(expiresInDays);
  const canCreate = name.trim().length > 0
    && Number.isInteger(days)
    && days >= 1
    && days <= 365
    && !submitting;

  return (
    <div className="card admin-api-tokens-card">
      <div className="admin-players-header">
        <div className="admin-players-title">
          <h3><KeyRound size={18} /> {t('admin.apiTokensTitle')}</h3>
          <p className="muted">{t('admin.apiTokensCount', { count: tokens.length })}</p>
        </div>
      </div>

      <div className="admin-api-token-form">
        <label className="admin-player-field">
          <span>{t('admin.apiTokenName')}</span>
          <input
            className="input"
            maxLength={64}
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={t('admin.apiTokenNamePlaceholder')}
          />
        </label>
        <label className="admin-player-field">
          <span>{t('admin.apiTokenExpiresIn')}</span>
          <input
            className="input"
            type="number"
            min={1}
            max={365}
            step={1}
            value={expiresInDays}
            onChange={(event) => setExpiresInDays(event.target.value)}
          />
        </label>
        <button className="btn btn-green" type="button" disabled={!canCreate} onClick={() => void create()}>
          <Plus size={17} />
          {submitting ? t('admin.creatingApiToken') : t('admin.createApiToken')}
        </button>
      </div>

      {created && (
        <section className="admin-api-token-secret" aria-live="polite">
          <div>
            <strong>{t('admin.newApiToken')}</strong>
            <p className="muted">{t('admin.apiTokenShownOnce')}</p>
          </div>
          <div className="admin-api-token-copy-row">
            <input className="input" readOnly value={created.token} aria-label={t('admin.newApiToken')} />
            <button className="btn btn-ghost" type="button" onClick={() => void copy()}>
              {copied ? <Check size={17} /> : <Copy size={17} />}
              {copied ? t('admin.apiTokenCopied') : t('admin.copyApiToken')}
            </button>
          </div>
        </section>
      )}

      <div className="admin-api-token-list">
        {loading ? (
          <p className="muted admin-api-token-empty">{t('common.loading')}</p>
        ) : tokens.length === 0 ? (
          <p className="muted admin-api-token-empty">{t('admin.noApiTokens')}</p>
        ) : tokens.map((token) => (
          <div className="admin-api-token-row" key={token.id}>
            <div className="admin-api-token-identity">
              <strong>{token.name}</strong>
              <code>{token.prefix}</code>
            </div>
            <div className="admin-api-token-dates">
              <span>{t('admin.apiTokenCreatedAt', {
                date: new Date(token.created_at).toLocaleString(currentLocale()),
              })}</span>
              <span>{t('admin.apiTokenExpiresAt', {
                date: new Date(token.expires_at).toLocaleString(currentLocale()),
              })}</span>
            </div>
            <button className="btn btn-red" type="button" onClick={() => void revoke(token)}>
              <Trash2 size={16} />
              {t('admin.revokeApiToken')}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
