import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from './api';
import type { MapDefinition } from './types';

export default function MapBanSelect({ value, onChange, disabled }: {
  value: string[]; onChange: (ids: string[]) => void; disabled: boolean;
}) {
  const { t } = useTranslation();
  const [maps, setMaps] = useState<MapDefinition[]>([]);
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading');
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setStatus('loading');
    void api.get<MapDefinition[]>('/location/maps', { signal: controller.signal }).then(response => {
      if (controller.signal.aborted) return;
      setMaps(response.data);
      setStatus('ready');
    }).catch(() => { if (!controller.signal.aborted) setStatus('error'); });
    return () => controller.abort();
  }, [retry]);
  return <details className="location-ban-select">
    <summary><span>{t('location.banMaps')}</span> <span className="location-ban-count">{value.length} / 2</span></summary>
    <fieldset disabled={disabled} aria-label={t('location.banMaps')}>
    <p className="location-rules-note">{t('location.banHelp')}</p>
    {value.length > 0 && <button type="button" className="btn btn-ghost btn-sm location-ban-clear" onClick={() => onChange([])}>{t('location.banClear')}</button>}
    {status === 'loading' && <p role="status">{t('location.banLoading')}</p>}
    {status === 'error' && <p>{t('location.banLoadFailed')} <button type="button" className="btn btn-ghost btn-sm" onClick={() => setRetry(n => n + 1)}>{t('location.retry')}</button></p>}
    <div className="location-map-options">
      {maps.map(map => {
        const banned = value.includes(map.id);
        return <button type="button" key={map.id} aria-pressed={banned}
          className={`location-map-option${banned ? ' location-map-banned' : ''}`}
          disabled={disabled || (!banned && value.length >= 2)}
          onClick={() => onChange(banned ? value.filter(id => id !== map.id) : [...value, map.id])}>
          <span>{t(`location.mapNames.${map.id}`, { defaultValue: map.name })}</span>
          {banned && <small>{t('location.banned')}</small>}
        </button>;
      })}
    </div>
    </fieldset>
  </details>;
}
