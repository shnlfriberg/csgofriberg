import { useEffect, useRef, useState, type PointerEvent } from 'react';
import type { Guess, MapDefinition } from './types';
import type { RadarSelection } from './Radar';

export function rectangleBetween(start: { u: number; v: number }, end: { u: number; v: number }): RadarSelection {
  return {
    minU: Math.min(start.u, end.u), minV: Math.min(start.v, end.v),
    maxU: Math.max(start.u, end.u), maxV: Math.max(start.v, end.v),
  };
}

export function useRadarGestures({ map, floorId, onChange, onSelectArea, failed }: { map: MapDefinition; floorId: string; onChange?: (guess: Guess) => void; onSelectArea?: (area: RadarSelection) => void; failed: boolean }) {
  const area = useRef<HTMLDivElement>(null);
  const [view, setView] = useState({ zoom: 1, x: 0, y: 0 });
  const viewRef = useRef(view);
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const down = useRef({ x: 0, y: 0, moved: false });
  const drawing = useRef<{ pointerId: number; start: { u: number; v: number } } | null>(null);
  const [preview, setPreview] = useState<RadarSelection | null>(null);
  const selecting = Boolean(onSelectArea);
  useEffect(() => {
    drawing.current = null;
    pointers.current.clear();
    setPreview(null);
  }, [selecting, map.id, map.version, floorId]);
  const pointAt = (event: PointerEvent<HTMLDivElement>) => {
    const rect = area.current?.getBoundingClientRect();
    if (!rect?.width || !rect.height) return null;
    const current = viewRef.current;
    return {
      u: Math.max(0, Math.min(1, (event.clientX - rect.left - current.x) / (rect.width * current.zoom))),
      v: Math.max(0, Math.min(1, (event.clientY - rect.top - current.y) / (rect.height * current.zoom))),
    };
  };
  const update = (value: typeof view) => {
    viewRef.current = value;
    setView(value);
  };
  const zoom = (factor: number, x?: number, y?: number) => {
    const current = viewRef.current;
    const next = Math.max(1, Math.min(6, current.zoom * factor));
    const rect = area.current?.getBoundingClientRect();
    const anchorX = x ?? (rect?.width || 0) / 2;
    const anchorY = y ?? (rect?.height || 0) / 2;
    update(
      next === 1
        ? { zoom: 1, x: 0, y: 0 }
        : {
            zoom: next,
            x: anchorX - ((anchorX - current.x) * next) / current.zoom,
            y: anchorY - ((anchorY - current.y) * next) / current.zoom,
          }
    );
  };
  useEffect(() => {
    update({ zoom: 1, x: 0, y: 0 });
  }, [map.id, map.version]);
  useEffect(() => {
    const element = area.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (drawing.current) return;
      const rect = element.getBoundingClientRect();
      zoom(
        Math.exp(-event.deltaY * 0.002),
        event.clientX - rect.left,
        event.clientY - rect.top
      );
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, [map.id]);
  const move = (event: PointerEvent<HTMLDivElement>) => {
    if (onSelectArea) {
      const point = pointAt(event);
      if (drawing.current?.pointerId === event.pointerId && point) {
        setPreview(rectangleBetween(drawing.current.start, point));
      }
      return;
    }
    const previous = pointers.current.get(event.pointerId);
    if (!previous) return;
    const before = [...pointers.current.values()];
    pointers.current.set(event.pointerId, {
      x: event.clientX,
      y: event.clientY,
    });
    if (pointers.current.size === 2) {
      down.current.moved = true;
      const after = [...pointers.current.values()];
      const initial = Math.hypot(
        before[0].x - before[1].x,
        before[0].y - before[1].y
      );
      const distance = Math.hypot(
        after[0].x - after[1].x,
        after[0].y - after[1].y
      );
      const rect = area.current!.getBoundingClientRect();
      if (initial > 0)
        zoom(
          distance / initial,
          (after[0].x + after[1].x) / 2 - rect.left,
          (after[0].y + after[1].y) / 2 - rect.top
        );
    } else if (
      Math.hypot(
        event.clientX - down.current.x,
        event.clientY - down.current.y
      ) >= 6 ||
      down.current.moved
    ) {
      down.current.moved = true;
      const current = viewRef.current;
      update({
        ...current,
        x: current.x + event.clientX - previous.x,
        y: current.y + event.clientY - previous.y,
      });
    }
  };
  const release = (event: PointerEvent<HTMLDivElement>, cancelled = false) => {
    if (onSelectArea) {
      pointers.current.delete(event.pointerId);
      const draft = drawing.current;
      if (!draft || draft.pointerId !== event.pointerId) return;
      drawing.current = null;
      setPreview(null);
      const point = pointAt(event);
      const rect = area.current?.getBoundingClientRect();
      if (!cancelled && point && rect && !failed) {
        const next = rectangleBetween(draft.start, point);
        // A tap or a line is not a region. Measure in screen pixels even when zoomed.
        if ((next.maxU - next.minU) * rect.width * viewRef.current.zoom >= 3 &&
            (next.maxV - next.minV) * rect.height * viewRef.current.zoom >= 3) onSelectArea(next);
      }
      return;
    }
    const wasDown = pointers.current.has(event.pointerId);
    pointers.current.delete(event.pointerId);
    if (!wasDown || cancelled || down.current.moved || !onChange || failed)
      return;
    const rect = area.current!.getBoundingClientRect();
    const current = viewRef.current;
    const u =
      (event.clientX - rect.left - current.x) / (rect.width * current.zoom);
    const v =
      (event.clientY - rect.top - current.y) / (rect.height * current.zoom);
    if (u >= 0 && u <= 1 && v >= 0 && v <= 1)
      onChange({ mapId: map.id, floorId, u, v });
  };
  return { area, view, viewRef, pointers, down, drawing, preview, setPreview, selecting, pointAt, update, zoom, move, release };
}
