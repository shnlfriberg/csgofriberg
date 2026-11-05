import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, message } from '../../../location/api';
import {
  parseCapturePosition,
  type WorldPosition,
  type CapturePosition,
} from '../../../location/positionCode';
import { uploadCaptureImage, validCaptureFile } from './api';
import { captureImages, sameWorldPosition } from '@friberg/location-core';
import {
  worldToRadar,
  coordinateDistance,
  COORDINATE_TOLERANCE,
} from '@friberg/location-core';
import type {
  CaptureDraft,
  Guess,
  MapDefinition,
  Question,
  Tier,
} from '../../../location/types';

interface Asset {
  url: string;
  thumbnailUrl: string;
  hash: string;
  width?: number;
  height?: number;
}
export interface Props {
  maps: MapDefinition[];
  question: Question | null;
  captureDraft?: CaptureDraft | null;
  captureImageId?: string;
  pointReference?: Question | null;
  onClose: () => void;
  onSaved: (question: Question, next?: boolean) => void;
}
function localDate(iso?: string) {
  const date = iso ? new Date(iso) : new Date();
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, 16);
}
export function useQuestionEditor({
  maps,
  question,
  captureDraft,
  captureImageId,
  pointReference,
  onClose,
  onSaved,
}: Props) {
  const { t } = useTranslation();
  const dialog = useRef<HTMLDialogElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const mounted = useRef(true);
  const sharedWorld = captureDraft?.world || pointReference?.world || question?.world;
  const lockedPoint = Boolean(sharedWorld || pointReference);
  const selectedCaptureImage = captureDraft
    ? captureImages(captureDraft).find((image) => image.id === captureImageId) || captureImages(captureDraft)[0]
    : undefined;
  const initialMap =
    maps.find((map) => map.id === (question?.mapId || captureDraft?.mapId || pointReference?.mapId)) ||
    maps[0];
  const [mapId, setMapId] = useState(initialMap.id);
  const [floorId, setFloorId] = useState(
    question?.floorId ||
      captureDraft?.floorId ||
      pointReference?.floorId ||
      (initialMap.floors.length === 1 ? initialMap.floors[0].id : '')
  );
  const [asset, setAsset] = useState<Asset | null>(
    question
      ? {
          url: question.imageUrl,
          thumbnailUrl: question.thumbnailUrl,
          hash: question.imageHash,
        }
      : selectedCaptureImage?.asset || null
  );
  const [pin, setPin] = useState<Guess | null>(
    question || captureDraft || pointReference
      ? {
          mapId: (question || captureDraft || pointReference)!.mapId,
          floorId: (question || captureDraft || pointReference)!.floorId,
          ...(sharedWorld ? worldToRadar(initialMap, sharedWorld) : {
            u: (question || captureDraft || pointReference)!.u,
            v: (question || captureDraft || pointReference)!.v,
          }),
        }
      : null
  );
  const [tier, setTier] = useState<Tier | ''>(
    question?.tier || (captureDraft ? '' : 'medium')
  );
  const [point, setPoint] = useState(
    question?.capturePointId ||
      captureDraft?.capturePointId ||
      pointReference?.capturePointId ||
      crypto.randomUUID()
  );
  const [capturedAt, setCapturedAt] = useState(localDate(question?.capturedAt));
  const [build, setBuild] = useState(question?.build || pointReference?.build || '');
  const [source, setSource] = useState(
    question?.source || t('location.captureSourceDefault')
  );
  const [world, setWorld] = useState({
    x: sharedWorld?.x.toString() || '',
    y: sharedWorld?.y.toString() || '',
    z: sharedWorld?.z.toString() || '',
  });
  const [view, setView] = useState({
    pitch: question?.view?.pitch.toString() || '',
    yaw: question?.view?.yaw.toString() || '',
    roll: question?.view?.roll.toString() || '0',
    fov: question?.view?.fov.toString() || pointReference?.view?.fov.toString() || '90',
  });
  const [paste, setPaste] = useState('');
  const [error, setError] = useState('');
  const [pointMismatch, setPointMismatch] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [progress, setProgress] = useState(0);
  const [dragging, setDragging] = useState(false);
  const map = maps.find((map) => map.id === mapId)!;
  const busy = uploading || saving;
  const [positionVerified, setPositionVerified] = useState(false);
  const mapChanged = Boolean(
    captureDraft && captureDraft.mapVersion !== map.version
  );
  const measured = Object.values(world).every(
    (value) => value.trim() !== '' && Number.isFinite(Number(value))
  );
  const camera =
    Object.values(view).every(
      (value) => value.trim() !== '' && Number.isFinite(Number(value))
    ) &&
    Number(view.fov) > 0 &&
    Number(view.fov) < 180;
  const converted =
    world.x !== '' && world.y !== ''
      ? {
          mapId,
          floorId,
          ...worldToRadar(map, { x: Number(world.x), y: Number(world.y) }),
        }
      : null;
  const withinRadar =
    converted &&
    [converted.u, converted.v].every(
      (value) => Number.isFinite(value) && value >= 0 && value <= 1
    );
  const mismatch =
    measured && pin && converted
      ? coordinateDistance(pin, converted) > COORDINATE_TOLERANCE
      : false;
  const canPublish =
    Boolean(tier) &&
    Boolean(asset && pin && floorId) &&
    Boolean(pin && pin.mapId === mapId && pin.floorId === floorId &&
      [pin.u, pin.v].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) &&
    !mismatch;
  useEffect(() => {
    mounted.current = true;
    dialog.current?.showModal();
    const old = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      mounted.current = false;
      document.body.style.overflow = old;
    };
  }, []);
  const upload = async (file?: File) => {
    if (!file || busy) return;
    setError('');
    if (!validCaptureFile(file)) {
      setError(t('location.uploadImageLimit'));
      return;
    }
    setUploading(true);
    setProgress(0);
    try {
      const uploaded = await uploadCaptureImage(file, (percent) => {
        if (mounted.current) setProgress(percent);
      });
      if (mounted.current) {
        setAsset(uploaded);
        setProgress(100);
      }
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setUploading(false);
    }
  };
  const applyPosition = (values: WorldPosition & Partial<CapturePosition>) => {
    const { pitch, yaw, roll } = values;
    if (pitch === undefined || yaw === undefined || roll === undefined) return;
    if (sharedWorld && !sameWorldPosition(sharedWorld, { x: Number(values.x), y: Number(values.y), z: Number(values.z) })) {
      setPointMismatch(true);
      setError(t('location.errors.LOCATION_CAPTURE_POSITION_MISMATCH'));
      return;
    }
    const position = sharedWorld || { x: Number(values.x), y: Number(values.y), z: Number(values.z) };
    setWorld(sharedWorld
      ? { x: String(sharedWorld.x), y: String(sharedWorld.y), z: String(sharedWorld.z) }
      : { x: values.x, y: values.y, z: values.z });
    setPointMismatch(false);
    setView((previous) => ({
      ...previous,
      pitch,
      yaw,
      roll,
    }));
    const { u, v } = worldToRadar(map, {
      x: position.x,
      y: position.y,
    });
    setPin(
      floorId && u >= 0 && u <= 1 && v >= 0 && v <= 1
        ? { mapId, floorId, u, v }
        : null
    );
    setError('');
  };
  const save = async (status: Question['status'], next = false) => {
    if (busy) return;
    setError('');
    if (pointMismatch) {
      setError(t('location.errors.LOCATION_CAPTURE_POSITION_MISMATCH'));
      return;
    }
    if (paste.trim() && !parseCapturePosition(paste)) {
      setError(t('location.positionParseFailed'));
      return;
    }
    if (!asset || !pin || !floorId) {
      setError(t('location.uploadPinRequired'));
      return;
    }
    if (mapChanged && !positionVerified) {
      setError(t('location.captureMapChanged'));
      return;
    }
    if (!tier) {
      setError(t('location.captureChooseTier'));
      return;
    }
    if (status === 'published' && !canPublish) {
      setError(t('location.publishRequirements'));
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...(question ? { id: question.id, version: question.version } : {}),
        mapVersion: map.version,
        ...pin,
        mapId,
        floorId,
        capturePointId: point.trim(),
        tier,
        status,
        imageUrl: asset.url,
        thumbnailUrl: asset.thumbnailUrl,
        imageHash: asset.hash,
        capturedAt: new Date(capturedAt || Date.now()).toISOString(),
        build: build.trim(),
        source: source.trim(),
        ...(measured
          ? {
              world: Object.fromEntries(
                Object.entries(world).map(([key, value]) => [
                  key,
                  Number(value),
                ])
              ),
            }
          : {}),
        ...(camera
          ? {
              view: Object.fromEntries(
                Object.entries(view).map(([key, value]) => [key, Number(value)])
              ),
            }
          : {}),
      };
      const response = captureDraft
        ? await api.post<Question>(
            `/admin/location/capture-drafts/${captureDraft.id}/complete`,
            { version: captureDraft.version, imageId: selectedCaptureImage?.id, question: payload }
          )
        : await api.post<Question>('/admin/location/questions', payload);
      if (mounted.current) onSaved(response.data, next);
    } catch (e) {
      if (mounted.current) setError(message(e));
    } finally {
      if (mounted.current) setSaving(false);
    }
  };
  return { t, dialog, fileInput, sharedWorld, lockedPoint, selectedCaptureImage, mapId, setMapId, floorId, setFloorId, asset, pin, setPin, tier, setTier, point, setPoint, capturedAt, setCapturedAt, build, setBuild, source, setSource, world, setWorld, view, setView, paste, setPaste, error, setError, pointMismatch, setPointMismatch, uploading, saving, progress, dragging, setDragging, map, busy, positionVerified, setPositionVerified, mapChanged, measured, camera, converted, withinRadar, mismatch, canPublish, upload, applyPosition, save };
}
