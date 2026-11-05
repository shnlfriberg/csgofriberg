import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SUBMISSION_LIMITS } from '@friberg/location-core';
import { validCaptureFile } from '../components/admin/location/api';
import { api, message } from './api';
import type { Guess, MapDefinition } from './types';

export interface SubmissionPoint extends Guess { id: string; order: number; mapVersion: number }
type UploadInput = Guess & { id: string; pointId: string; mapVersion: number; note: string };
export interface SubmissionImage {
  id: string; name: string; file?: File; pointId: string; note: string;
  status: 'queued' | 'sending' | 'sent' | 'error'; error?: string; locked?: boolean;
}

async function checkImage(file: File): Promise<void> {
  const url = URL.createObjectURL(file);
  try {
    await new Promise<void>((resolve, reject) => {
      const image = new Image();
      const timer = window.setTimeout(() => done('LOCATION_INVALID_ASSET'), 15_000);
      const done = (code?: string) => {
        window.clearTimeout(timer); image.onload = null; image.onerror = null; image.src = '';
        if (code) reject(new Error(code)); else resolve();
      };
      image.onload = () => done(image.naturalWidth < 360 || image.naturalHeight < 360
        ? 'LOCATION_CAPTURE_TOO_SMALL' : image.naturalWidth * image.naturalHeight > 16_000_000
          ? 'LOCATION_INVALID_ASSET' : undefined);
      image.onerror = () => done('LOCATION_INVALID_ASSET'); image.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}

export function useSubmissionBatch(onSubmitted: () => void) {
  const { t } = useTranslation();
  const [points, setPoints] = useState<SubmissionPoint[]>([]);
  const [images, setImages] = useState<SubmissionImage[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [imageId, setImageId] = useState('');
  const [marking, setMarking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [progress, setProgress] = useState({ current: 0, total: 0, percent: 0 });
  const mounted = useRef(true);
  const running = useRef(false);
  const nextOrder = useRef(1);
  const attempts = useRef(new Map<string, UploadInput>());
  const controller = useRef<AbortController>();
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; controller.current?.abort(); };
  }, []);
  useEffect(() => {
    if (!images.some(row => row.file)) return;
    const preventLoss = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', preventLoss);
    return () => window.removeEventListener('beforeunload', preventLoss);
  }, [images]);
  const selected = points.find(point => point.id === selectedId);
  const selectedImage = images.find(row => row.id === imageId);
  const pointLocked = (id: string) => images.some(row => row.pointId === id && (row.locked || row.status === 'sent'));
  const selectPoint = (id: string) => { if (!running.current) { setSelectedId(id); setMarking(false); } };
  const place = (guess: Guess, map: MapDefinition) => {
    if (running.current) return;
    setError('');
    if (!marking && selected) {
      if (pointLocked(selected.id)) return;
      setPoints(items => items.map(point => point.id === selected.id ? { ...point, ...guess, mapVersion: map.version } : point));
      return;
    }
    if (points.length >= SUBMISSION_LIMITS.points) { setError(t('location.submissionPointLimit')); return; }
    const point = { ...guess, id: crypto.randomUUID(), order: nextOrder.current++, mapVersion: map.version };
    setPoints(items => [...items, point]); setSelectedId(point.id);
    // Also support selecting images before the very first pin.
    setImages(items => items.map(row => !row.pointId && !row.locked ? { ...row, pointId: point.id } : row));
  };
  const queue = (files: File[]) => {
    if (running.current) return;
    setError(''); setNotice('');
    const added: SubmissionImage[] = [];
    let bytes = images.reduce((sum, row) => sum + (row.file?.size || 0), 0);
    for (const file of files) {
      if (!validCaptureFile(file)) { setError(t('location.uploadImageLimit')); continue; }
      if (images.filter(row => row.file).length + added.length >= SUBMISSION_LIMITS.batchImages || bytes + file.size > SUBMISSION_LIMITS.batchBytes) {
        setError(t('location.submissionQueueLimit')); break;
      }
      // Only reject the same browser File object; different same-name images may be valid.
      if ([...images, ...added].some(row => row.file === file)) continue;
      added.push({ id: crypto.randomUUID(), file, name: file.name, pointId: selectedId, note: '', status: 'queued' }); bytes += file.size;
    }
    if (added.length) { setImages(items => [...items, ...added]); setImageId(added[0].id); }
  };
  const updateImage = (id: string, change: Partial<Pick<SubmissionImage, 'pointId' | 'note'>>) => {
    if (running.current) return;
    setImages(items => items.map(row => row.id === id && row.file && !row.locked
      ? { ...row, ...change, status: 'queued', error: undefined } : row));
  };
  const removeImage = (id: string) => {
    if (running.current) return;
    attempts.current.delete(id); setImages(items => items.filter(row => row.id !== id));
    if (imageId === id) setImageId(images.find(row => row.id !== id)?.id || '');
  };
  const removePoint = () => {
    if (running.current || images.some(row => row.pointId === selectedId)) return;
    setPoints(items => items.filter(point => point.id !== selectedId)); setSelectedId(''); setMarking(true);
  };
  const remaining = images.filter(row => row.file);
  const canSubmit = remaining.length > 0 && remaining.every(row => points.some(point => point.id === row.pointId));
  const submit = async () => {
    if (running.current || !canSubmit) return;
    running.current = true; setBusy(true); setError(''); setNotice('');
    controller.current = new AbortController();
    let sent = 0;
    try {
      for (let index = 0; index < remaining.length && mounted.current; index++) {
        const row = remaining[index]; const file = row.file!;
        const point = points.find(point => point.id === row.pointId)!;
        const patch = (value: Partial<SubmissionImage>) => {
          if (mounted.current) setImages(items => items.map(item => item.id === row.id ? { ...item, ...value } : item));
        };
        setProgress({ current: index + 1, total: remaining.length, percent: 0 });
        patch({ status: 'sending', error: undefined });
        try {
          await checkImage(file);
          if (!mounted.current) break;
          const input = attempts.current.get(row.id) || { id: row.id, pointId: point.id, mapId: point.mapId,
            floorId: point.floorId, u: point.u, v: point.v, mapVersion: point.mapVersion, note: row.note.trim() };
          attempts.current.set(row.id, input); patch({ locked: true });
          await api.post('/location/submissions', await file.arrayBuffer(), {
            headers: { 'Content-Type': file.type }, params: input, signal: controller.current.signal, timeout: 60_000,
            onUploadProgress: event => mounted.current && setProgress({ current: index + 1, total: remaining.length,
              percent: Math.min(99, Math.round(event.loaded / (event.total || file.size) * 100)) }),
          });
          sent++; attempts.current.delete(row.id);
          // Release the original bitmap/file once the server has acknowledged it.
          patch({ status: 'sent', file: undefined, locked: false });
        } catch (e) {
          if (!mounted.current) break;
          const status = (e as { response?: { status?: number } }).response?.status;
          const localError = e instanceof Error && e.message.startsWith('LOCATION_');
          const definiteRejection = localError || (status !== undefined && status >= 400 && status < 500 && status !== 429);
          if (definiteRejection) attempts.current.delete(row.id);
          patch({ status: 'error', error: localError ? t(`location.errors.${e.message}`) : message(e), locked: attempts.current.has(row.id) });
          // Stop on outages/quotas; do not burn the rest of the batch's requests.
          if (!localError && (!status || status === 429 || status >= 500 || status === 401 || status === 403)) break;
        }
      }
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false); setNotice(t('location.submissionBatchResult', { count: sent }));
        onSubmitted();
      }
    }
  };
  return { points, images, selectedId, setSelectedId, imageId, setImageId, selected, selectedImage,
    marking, setMarking, busy, error, notice, progress, selectPoint, pointLocked, place, queue, updateImage,
    removeImage, removePoint, submit, canSubmit, remaining: remaining.length };
}
