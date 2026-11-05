import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { message } from '../../../location/api';
import { useConfirm } from '../../ConfirmDialog';
import type {
  CaptureDraft,
  Guess,
  MapDefinition,
} from '../../../location/types';
import { locationAdmin, uploadCaptureImage, validCaptureFile } from './api';
import {
  restoreCapturePoints,
  CAPTURE_STORAGE_KEY,
  type CaptureImageRow,
} from './capturePlan';
import { radarToWorld } from '@friberg/location-core';
import { useAdminTask } from './useAdminTask';
import { captureImages } from '@friberg/location-core';

export function useBatchCapture(maps: MapDefinition[], revision: number, visibleWorkspace = true) {
  const { t } = useTranslation();
  const confirm = useConfirm();
  const [drafts, setDrafts] = useState<CaptureDraft[]>([]);
  const [pending, setPending] = useState(() => restoreCapturePoints(maps));
  const [batchId, setBatchId] = useState(
    () => restoreCapturePoints(maps)[0]?.batchId || crypto.randomUUID()
  );
  const [batchName, setBatchName] = useState(
    () =>
      restoreCapturePoints(maps)[0]?.batchName ||
      new Date().toLocaleDateString('zh-CN')
  );
  const [mapId, setMapId] = useState(maps[0]?.id || '');
  const map = maps.find((m) => m.id === mapId);
  const [floorId, setFloorId] = useState(maps[0]?.floors[0]?.id || '');
  const [batchFilter, setBatchFilter] = useState('');
  const [marking, setMarking] = useState(true);
  const [selectedId, setSelectedId] = useState('');
  const [images, setImages] = useState<CaptureImageRow[]>([]);
  const imageRef = useRef(images);
  imageRef.current = images;
  const mapPanel = useRef<HTMLDivElement>(null);
  const {
    busy: saving,
    isBusy,
    error,
    setError,
    notice,
    setNotice,
    run,
  } = useAdminTask();
  const [loading, setLoading] = useState(true);
  const busy = saving || loading;
  const loadVersion = useRef(0);
  const load = async () => {
    const version = ++loadVersion.current;
    const items = await locationAdmin.captures();
    if (version !== loadVersion.current) return;
    setDrafts(items);
    const saved = new Set(items.map((p) => p.id));
    setPending((previous) => previous.filter((p) => !saved.has(p.id)));
  };
  useEffect(() => {
    if (!visibleWorkspace) return;
    let active = true;
    setLoading(true);
    void load()
      .catch((e) => active && setError(message(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
      loadVersion.current++;
    };
  }, [revision, visibleWorkspace]);
  useEffect(
    () => () => {
      imageRef.current.forEach((row) => URL.revokeObjectURL(row.preview));
    },
    []
  );
  useEffect(() => {
    try {
      localStorage.removeItem('tuxun:capture-points:v1');
      localStorage.setItem(CAPTURE_STORAGE_KEY, JSON.stringify(pending));
    } catch {
      setError(t('location.captureStorageFailed'));
    }
  }, [pending, t]);
  const visible = drafts.filter(
    (d) =>
      d.mapId === mapId &&
      d.floorId === floorId &&
      (!batchFilter || d.batchId === batchFilter)
  );
  const local = pending.filter(
    (p) => p.mapId === mapId && p.floorId === floorId &&
      (!batchFilter || p.batchId === batchFilter)
  );
  const selected = drafts.find((d) => d.id === selectedId);
  const selectedLocal = pending.find((p) => p.id === selectedId);
  const selectedImage = images.find((row) => row.target === selectedId);
  const [selectedImageId, setSelectedImageId] = useState('');
  const batches = [
    ...new Map([...drafts, ...pending]
      .filter((d) => d.mapId === mapId)
      .map((d) => [d.batchId, d.batchName])).entries(),
  ];
  const selectPoint = (id: string) => {
    setSelectedId(id);
    const point = drafts.find((p) => p.id === id);
    setSelectedImageId(point ? captureImages(point)[0]?.id || '' : '');
    setMarking(false);
  };
  const lastOrder = useRef(0);
  const newBatch = () => {
    setBatchId(crypto.randomUUID());
    setBatchName(new Date().toLocaleDateString('zh-CN'));
    setBatchFilter('');
    setSelectedId('');
    setMarking(true);
    lastOrder.current = 0;
  };
  const addPoint = (guess: Guess) => {
    if (isBusy() || loading || pending.length >= 500) return;
    const id = crypto.randomUUID();
    setSelectedId(id);
    const order =
      Math.max(
        lastOrder.current,
        ...pending.filter((p) => p.batchId === batchId).map((p) => p.order),
        ...drafts.filter((p) => p.batchId === batchId).map((p) => p.order)
      ) + 1;
    lastOrder.current = order;
    setPending((previous) => [
      ...previous,
      {
        ...guess,
        id,
        batchId,
        batchName: batchName.trim() || map?.name || 'CS2',
        order,
        capturePointId: `tx-${batchId.slice(0, 8)}-${String(order).padStart(3, '0')}`,
      },
    ]);
  };
  const savePoints = () =>
    run(async () => {
      const points = [...pending];
      const items = await locationAdmin.savePoints(points);
      const ids = new Set(points.map((p) => p.id));
      setPending((previous) => previous.filter((p) => !ids.has(p.id)));
      setDrafts((previous) => [
        ...previous.filter((p) => !ids.has(p.id)),
        ...items,
      ]);
      setMarking(false);
      setNotice(t('location.capturePointsSaved', { count: points.length }));
    });
  const bindFile = async (row: CaptureImageRow, draft: CaptureDraft) => {
    if (!validCaptureFile(row.file))
      throw new Error(t('location.uploadImageLimit'));
    const asset = row.asset || (await uploadCaptureImage(row.file));
    setImages((previous) =>
      previous.map((item) => (item.id === row.id ? { ...item, asset } : item))
    );
    const saved = await locationAdmin.appendImage(draft, row.id, asset);
    setDrafts((previous) =>
      previous.map((item) => (item.id === draft.id ? saved : item))
    );
    setSelectedImageId(row.id);
    return saved;
  };
  const queueFiles = (files: FileList | null, singleTarget = '') => {
    if (!files) return;
    const added = Array.from(files);
    const current = imageRef.current;
    if (added.some(file => !validCaptureFile(file)) || current.length + added.length > 100 ||
      [...current.map(row => row.file), ...added].reduce((sum, file) => sum + file.size, 0) > 256 * 1024 * 1024) {
      setError(t('location.captureQueueLimit', { defaultValue: '待上传图片最多 100 张、合计 256 MiB；请先上传或移除部分图片。' }));
      return;
    }
    const fresh: CaptureImageRow[] = Array.from(files)
      .sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true })
      )
      .map((file) => {
        const matches = drafts.filter(
          (d) =>
            (d.capturePointId.toLowerCase() === file.name.replace(/\.[^.]+$/, '').toLowerCase() ||
              file.name.replace(/\.[^.]+$/, '').toLowerCase().startsWith(`${d.capturePointId.toLowerCase()}__`))
        );
        return {
          id: crypto.randomUUID(),
          file,
          preview: URL.createObjectURL(file),
          target: singleTarget || (matches.length === 1 ? matches[0].id : ''),
        };
      });
    imageRef.current = [...imageRef.current, ...fresh];
    setImages(imageRef.current);
  };
  const saveImages = () =>
    run(async () => {
      let saved = 0;
      const latest = new Map(drafts.map((draft) => [draft.id, draft]));
      for (const row of images) {
        const draft = latest.get(row.target);
        if (!draft) continue;
        try {
          const point = await bindFile(row, draft);
          latest.set(point.id, point);
          saved++;
          URL.revokeObjectURL(row.preview);
          setImages((previous) =>
            previous.filter((item) => item.id !== row.id)
          );
        } catch (e) {
          setImages((previous) =>
            previous.map((item) =>
              item.id === row.id
                ? {
                    ...item,
                    error: e instanceof Error ? e.message : message(e),
                  }
                : item
            )
          );
        }
      }
      setNotice(t('location.captureImagesSaved', { count: saved }));
    });
  const exportPlan = () => {
    const points = [...visible, ...local];
    const csv = [
      [
        'point',
        'map',
        'floor',
        'u',
        'v',
        'referenceX',
        'referenceY',
        'imageFile',
      ],
      ...points.map((p) => {
        const m = maps.find((item) => item.id === p.mapId)!;
        return [
          p.capturePointId,
          p.mapId,
          p.floorId,
          p.u,
          p.v,
          radarToWorld(m, p).x,
          radarToWorld(m, p).y,
          `${p.capturePointId}.png`,
        ];
      }),
    ]
      .map((row) =>
        row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(',')
      )
      .join('\r\n');
    const url = URL.createObjectURL(
      new Blob(['\uFEFF', csv], { type: 'text/csv;charset=utf-8' })
    );
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `tuxun-${mapId}-${floorId}.csv`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const removeImage = (imageId: string) => run(async () => {
    if (!selected) return;
    const saved = await locationAdmin.removeImage(selected, imageId);
    setDrafts((previous) => previous.map((p) => p.id === saved.id ? saved : p));
    setSelectedImageId(captureImages(saved)[0]?.id || '');
  });
  const removeSelected = async () => {
    if (
      !(await confirm({
        title: t('location.captureRemove'),
        message: t('location.captureRemovePrompt'),
        tone: 'warning',
      }))
    )
      return;
    if (selectedLocal) {
      setPending((previous) =>
        previous.filter((p) => p.id !== selectedLocal.id)
      );
      setSelectedId('');
    } else if (selected)
      await run(async () => {
        await locationAdmin.removePoint(selected);
        setDrafts((previous) => previous.filter((p) => p.id !== selected.id));
        setSelectedId('');
      });
  };
  return {
    t,
    drafts,
    pending,
    batchName,
    setBatchName,
    mapId,
    setMapId,
    map,
    floorId,
    setFloorId,
    batchFilter,
    setBatchFilter,
    marking,
    setMarking,
    selectedId,
    setSelectedId,
    images,
    setImages,
    mapPanel,
    busy,
    error,
    notice,
    run,
    load,
    visible,
    local,
    selected,
    selectedLocal,
    selectedImage,
    batches,
    selectPoint,
    addPoint,
    savePoints,
    queueFiles,
    saveImages,
    exportPlan,
    selectedImageId,
    setSelectedImageId,
    removeImage,
    removeSelected,
    newBatch,
  };
}
