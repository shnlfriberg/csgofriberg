import { useEffect, useId, useRef, useState } from 'react';
import { Megaphone } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import ModalPortal from './ModalPortal';

const ACKNOWLEDGED_STORAGE_KEY = 'csgofriberg.acknowledged-popup-announcements';
const MAX_ACKNOWLEDGED_IDS = 50;

interface PopupAnnouncement {
  id: number;
  title: string;
  content: string;
}

function acknowledgedIds(): Set<number> {
  try {
    const value = JSON.parse(localStorage.getItem(ACKNOWLEDGED_STORAGE_KEY) ?? '[]');
    if (!Array.isArray(value)) return new Set();
    return new Set(value.filter((id) => Number.isInteger(id) && id > 0).slice(0, MAX_ACKNOWLEDGED_IDS));
  } catch {
    return new Set();
  }
}

function rememberAcknowledged(id: number): void {
  try {
    const ids = [...acknowledgedIds()];
    const next = [id, ...ids.filter((candidate) => candidate !== id)]
      .slice(0, MAX_ACKNOWLEDGED_IDS);
    localStorage.setItem(ACKNOWLEDGED_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // The current dialog can still close when browser storage is unavailable.
  }
}

function popupAnnouncements(value: unknown): PopupAnnouncement[] {
  if (!Array.isArray(value)) return [];
  const acknowledged = acknowledgedIds();
  const seen = new Set<number>();
  const result: PopupAnnouncement[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object') continue;
    const row = item as Record<string, unknown>;
    const id = Number(row.id);
    const isPopup = row.is_popup === true || row.is_popup === 1;
    if (
      !Number.isInteger(id)
      || id <= 0
      || !isPopup
      || acknowledged.has(id)
      || seen.has(id)
      || typeof row.title !== 'string'
      || typeof row.content !== 'string'
    ) continue;
    seen.add(id);
    result.push({ id, title: row.title, content: row.content });
  }
  return result;
}

export default function AnnouncementDialog() {
  const { t } = useTranslation();
  const [queue, setQueue] = useState<PopupAnnouncement[]>([]);
  const acknowledgeButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();
  const contentId = useId();
  const current = queue[0] ?? null;

  useEffect(() => {
    let disposed = false;
    void api.get('/announcements')
      .then((response) => {
        if (!disposed) setQueue(popupAnnouncements(response.data));
      })
      .catch(() => undefined);
    return () => {
      disposed = true;
    };
  }, []);

  useEffect(() => {
    if (!current) return;
    const oldOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    acknowledgeButtonRef.current?.focus();
    return () => {
      document.body.style.overflow = oldOverflow;
    };
  }, [current]);

  if (!current) return null;

  const acknowledge = () => {
    rememberAcknowledged(current.id);
    setQueue((items) => items.slice(1));
  };

  return (
    <ModalPortal>
      <div className="confirm-backdrop">
        <div
          className="confirm-dialog warning announcement-popup-dialog"
          role="alertdialog"
          aria-modal="true"
          aria-labelledby={titleId}
          aria-describedby={contentId}
        >
          <div className="confirm-icon" aria-hidden="true">
            <Megaphone size={22} />
          </div>
          <div className="confirm-content">
            <div className="confirm-heading">
              <h2 id={titleId}>{current.title}</h2>
            </div>
            <p id={contentId} className="announcement-popup-content">{current.content}</p>
            <div className="confirm-actions announcement-popup-actions">
              <button
                ref={acknowledgeButtonRef}
                className="btn btn-warning"
                type="button"
                onClick={acknowledge}
              >
                {t('announcements.acknowledge')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
