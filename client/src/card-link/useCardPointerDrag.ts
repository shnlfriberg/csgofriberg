import { useCallback, useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';

export type DragCard = { id: number; kind: 'hand' | 'board' | 'search' };
type Drag = DragCard & { pointer: number; source: HTMLElement; x: number; y: number;
  offsetX: number; offsetY: number; width: number; height: number; preview: HTMLElement | null };
type TouchSelection = DragCard & { source: HTMLElement };
type TouchTap = TouchSelection & { pointer: number; x: number; y: number };
const MOVE_THRESHOLD = 6;

/** Pointer capture keeps dragging independent of browser native drag/search and
 * animation snapshots. No React state updates or game commands while moving. */
export function useCardPointerDrag(context: string, enabled: boolean, drop: (card: DragCard, index: number) => void) {
  const drag = useRef<Drag | null>(null), target = useRef<HTMLElement | null>(null);
  const tap = useRef<TouchTap | null>(null), selected = useRef<TouchSelection | null>(null);
  const [touchSelected, setTouchSelected] = useState<TouchSelection | null>(null);
  const select = useCallback((value: TouchSelection | null) => {
    selected.current = value;
    setTouchSelected(value);
  }, []);
  const callback = useRef(drop), allowed = useRef(enabled), suppressClick = useRef(false);
  callback.current = drop;
  allowed.current = enabled;
  const end = useCallback(() => {
    tap.current = null;
    select(null);
    const active = drag.current;
    drag.current = null;
    active?.preview?.remove();
    active?.source.classList.remove('cl-dragging');
    if (active?.source.hasPointerCapture?.(active.pointer)) active.source.releasePointerCapture(active.pointer);
    target.current?.classList.remove('cl-drop-target');
    target.current = null;
  }, [select]);
  useEffect(() => { end(); suppressClick.current = false; return end; }, [context, end]);
  useEffect(() => { if (!enabled) end(); }, [enabled, end]);
  useEffect(() => { if (selected.current && !selected.current.source.isConnected) end(); });
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const candidate = tap.current;
      if (candidate?.pointer === event.pointerId) {
        // Leave this gesture entirely to native scrolling, even after crossing the threshold.
        if (Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) >= MOVE_THRESHOLD) tap.current = null;
        return;
      }
      const active = drag.current;
      if (!active || event.pointerId !== active.pointer) return;
      if (!allowed.current || !active.source.isConnected) { end(); return; }
      if (!active.preview) {
        if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < MOVE_THRESHOLD) return;
        const preview = active.source.cloneNode(true) as HTMLElement;
        for (const attr of ['id', 'data-cl-card', 'data-cl-area', 'data-cl-drop-index']) preview.removeAttribute(attr);
        preview.draggable = false;
        preview.inert = true;
        preview.setAttribute('aria-hidden', 'true');
        preview.classList.add('cl-card-drag-preview');
        Object.assign(preview.style, { position: 'fixed', left: '0', top: '0', width: `${active.width}px`,
          height: `${active.height}px`, margin: '0', zIndex: '10000', pointerEvents: 'none', opacity: '1' });
        document.body.appendChild(preview);
        active.preview = preview;
        active.source.classList.add('cl-dragging');
      }
      event.preventDefault();
      active.preview.style.transform = `translate(${event.clientX - active.offsetX}px, ${event.clientY - active.offsetY}px)`;
      const next = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-cl-drop-index]') ?? null;
      if (next !== target.current) {
        target.current?.classList.remove('cl-drop-target');
        target.current = next;
        next?.classList.add('cl-drop-target');
      }
    };
    const up = (event: PointerEvent) => {
      const candidate = tap.current;
      if (candidate?.pointer === event.pointerId) {
        tap.current = null;
        if (allowed.current && candidate.source.isConnected &&
            Math.hypot(event.clientX - candidate.x, event.clientY - candidate.y) < MOVE_THRESHOLD) select(candidate);
        return;
      }
      const active = drag.current;
      if (!active || event.pointerId !== active.pointer) return;
      const moved = !!active.preview;
      const zone = document.elementFromPoint(event.clientX, event.clientY)?.closest<HTMLElement>('[data-cl-drop-index]');
      const index = zone ? Number(zone.dataset.clDropIndex) : NaN;
      end();
      if (!moved) return;
      suppressClick.current = true;
      event.preventDefault();
      if (allowed.current && Number.isInteger(index) && index >= 0) callback.current(active, index);
    };
    const cancel = (event: PointerEvent) => {
      if (event.pointerId === drag.current?.pointer || event.pointerId === tap.current?.pointer) end();
    };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') end(); };
    const down = (event: PointerEvent) => {
      suppressClick.current = false;
      if (event.isPrimary === false || (selected.current &&
          (!(event.target instanceof Node) || !selected.current.source.contains(event.target))) ||
          (event.target instanceof Element && event.target.closest('button, input, select, a'))) end();
    };
    const click = (event: MouseEvent) => {
      if (!suppressClick.current) return;
      suppressClick.current = false;
      event.preventDefault(); event.stopPropagation();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerdown', down, true);
    window.addEventListener('pointerup', up);
    window.addEventListener('pointercancel', cancel);
    window.addEventListener('blur', end);
    window.addEventListener('keydown', key);
    window.addEventListener('click', click, true);
    return () => {
      end();
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerdown', down, true);
      window.removeEventListener('pointerup', up);
      window.removeEventListener('pointercancel', cancel);
      window.removeEventListener('blur', end);
      window.removeEventListener('keydown', key);
      window.removeEventListener('click', click, true);
    };
  }, [end, select]);
  const start = (event: ReactPointerEvent<HTMLElement>, card: DragCard) => {
    suppressClick.current = false;
    if (!enabled || event.button !== 0 || event.isPrimary === false ||
        (event.target as HTMLElement).closest('button, input, select, a')) return;
    const armed = selected.current?.source === event.currentTarget &&
      selected.current.id === card.id && selected.current.kind === card.kind;
    end();
    if (event.pointerType === 'touch' && card.kind !== 'board' && !armed) {
      // Do not capture or preventDefault: an unselected hand must pan naturally.
      // Selection is applied on release so touch-action is ready for the NEXT gesture.
      tap.current = { ...card, source: event.currentTarget, pointer: event.pointerId, x: event.clientX, y: event.clientY };
      return;
    }
    if (event.pointerType === 'touch' && armed) select({ ...card, source: event.currentTarget });
    const source = event.currentTarget, rect = source.getBoundingClientRect();
    drag.current = { ...card, pointer: event.pointerId, source, x: event.clientX, y: event.clientY,
      offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
      width: rect.width, height: rect.height, preview: null };
    source.setPointerCapture?.(event.pointerId);
  };
  return { start, end, touchSelected };
}
