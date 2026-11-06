import { useCallback, useEffect, useState } from 'react';
import { Check, Copy, KeyRound, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api, errMsg } from '../../api/client';
import { currentLocale } from '../../i18n';
import { useConfirm } from '../ConfirmDialog';
import { toast } from '../Toast';
import Badge from '../Badge';
import DataTable, { type Column } from '../DataTable';
import AdminDialog from './AdminDialog';
import { Panel, Toolbar, formatDateTime } from './ui';

interface ApiTokenItem {
  scopes?: string[];
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
  const locale = currentLocale();
  const [tokens, setTokens] = useState<ApiTokenItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);

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

  const columns: Column<ApiTokenItem>[] = [
    { key: 'name', title: t('admin.apiTokenName'), render: (token) => <span className="admin-cell-stack"><strong>{token.name}</strong><small className="admin-mono">{token.prefix}</small></span> },
    {
      key: 'scopes',
      title: t('adminUi.tokenScopes'),
      render: (token) => token.scopes?.includes('players:write')
        ? <Badge text={t('location.tokenDirectWrite')} color="amber" />
        : <span className="admin-cell-clamp">{t('location.tokenDefaultScopes')}</span>,
    },
    { key: 'created_at', title: t('adminUi.tokenCreated'), render: (token) => formatDateTime(token.created_at, locale) },
    { key: 'expires_at', title: t('adminUi.tokenExpires'), render: (token) => formatDateTime(token.expires_at, locale) },
    { key: 'actions', title: t('admin.actions'), render: (token) => <button className="admin-action is-danger" type="button" onClick={() => void revoke(token)}>{t('admin.revokeApiToken')}</button> },
  ];

  return (
    <>
      <Panel flush className="admin-list-panel">
        <Toolbar
          end={(
            <button className="btn btn-sm" type="button" onClick={() => setCreating(true)}>
              <Plus size={15} />{t('adminUi.newToken')}
            </button>
          )}
        >
          <span className="admin-toolbar-meta">{t('admin.apiTokensCount', { count: tokens.length })}</span>
        </Toolbar>
        <div className="admin-table">
          <DataTable columns={columns} rows={tokens} rowKey={(token) => token.id} loading={loading} empty={t('admin.noApiTokens')} />
        </div>
      </Panel>
      {creating && <TokenCreateDialog onClose={() => setCreating(false)} onCreated={load} />}
    </>
  );
}

/** Two steps in one dialog: fill in the form, then show the plaintext secret exactly once. */
function TokenCreateDialog({ onClose, onCreated }: { onClose: () => void; onCreated: () => Promise<void> }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [expiresInDays, setExpiresInDays] = useState('90');
  const [directWrite, setDirectWrite] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<CreatedApiToken | null>(null);
  const [copied, setCopied] = useState(false);

  const days = Number(expiresInDays);
  const canCreate = name.trim().length > 0 && Number.isInteger(days) && days >= 1 && days <= 365 && !submitting;

  const create = async () => {
    if (!canCreate) return;
    setSubmitting(true);
    try {
      const response = await api.post<CreatedApiToken>('/admin/api-tokens', {
        name: name.trim(),
        expiresInDays: days,
        scopes: ['players:read', 'changes:submit', ...(directWrite ? ['players:write'] : [])],
      });
      setCreated(response.data);
      toast.success(t('admin.apiTokenCreated'));
      await onCreated();
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

  if (created) {
    return (
      <AdminDialog
        key="secret"
        title={t('adminUi.tokenReady')}
        subtitle={created.name}
        icon={<KeyRound size={18} aria-hidden="true" />}
        onClose={onClose}
        footer={<button className="btn btn-sm" type="button" onClick={onClose}>{t('adminUi.done')}</button>}
      >
        <section className="admin-callout is-warning" aria-live="polite">
          <p><strong>{t('admin.newApiToken')}</strong></p>
          <p className="admin-help">{t('admin.apiTokenShownOnce')}</p>
          <div className="admin-copy-row">
            <input className="input" readOnly value={created.token} aria-label={t('admin.newApiToken')} onFocus={(event) => event.target.select()} />
            <button className="btn btn-ghost btn-sm" type="button" onClick={() => void copy()}>
              {copied ? <Check size={15} /> : <Copy size={15} />}
              {copied ? t('admin.apiTokenCopied') : t('admin.copyApiToken')}
            </button>
          </div>
        </section>
      </AdminDialog>
    );
  }

  return (
    <AdminDialog
      title={t('adminUi.newToken')}
      icon={<KeyRound size={18} aria-hidden="true" />}
      onClose={onClose}
      footer={(
        <>
          <button className="btn btn-ghost btn-sm" type="button" onClick={onClose}>{t('common.cancel')}</button>
          <button className="btn btn-sm" type="submit" form="admin-token-form" disabled={!canCreate}>
            <Plus size={15} />{submitting ? t('admin.creatingApiToken') : t('admin.createApiToken')}
          </button>
        </>
      )}
    >
      <form id="admin-token-form" className="admin-form-stack" onSubmit={(event) => { event.preventDefault(); void create(); }}>
        <label className="admin-field">
          <span>{t('admin.apiTokenName')}</span>
          <input className="input" maxLength={64} value={name} onChange={(event) => setName(event.target.value)} placeholder={t('admin.apiTokenNamePlaceholder')} />
        </label>
        <label className="admin-field">
          <span>{t('admin.apiTokenExpiresIn')}</span>
          <input className="input" type="number" min={1} max={365} step={1} value={expiresInDays} onChange={(event) => setExpiresInDays(event.target.value)} />
        </label>
        <label className="admin-check">
          <input type="checkbox" checked={directWrite} onChange={(event) => setDirectWrite(event.target.checked)} />
          <span>{t('location.tokenDirectWrite')}</span>
        </label>
        <p className="admin-help">{t('location.tokenDefaultScopes')}</p>
      </form>
    </AdminDialog>
  );
}
