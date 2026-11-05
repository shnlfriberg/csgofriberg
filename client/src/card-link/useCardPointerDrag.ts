import { useCallback, useEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';

export type DragCard = { id: number; kind: 'hand' | 'board' | 'search' };
type Drag = DragCard & { pointer: number; source: HTMLElement; x: number; y: number;
  offsetX: number; offsetY: number; width: number; height: number; preview: HTMLElement | null };

/** Pointer capture keeps dragging independent of browser native drag/search and
 * animation snapshots. No React state updates or game commands while moving. */
export function useCardPointerDrag(context: string, enabled: boolean, drop: (card: DragCard, index: number) => void) {
  const drag = useRef<Drag | null>(null), target = useRef<HTMLElement | null>(null);
  const callback = useRef(drop), allowed = useRef(enabled), suppressClick = useRef(false);
  callback.current = drop;
  allowed.current = enabled;
  const end = useCallback(() => {
    const active = drag.current;
    drag.current = null;
    active?.preview?.remove();
    active?.source.classList.remove('cl-dragging');
    if (active?.source.hasPointerCapture?.(active.pointer)) active.source.releasePointerCapture(active.pointer);
    target.current?.classList.remove('cl-drop-target');
    target.current = null;
  }, []);
  useEffect(() => { end(); suppressClick.current = false; return end; }, [context, end]);
  useEffect(() => { if (!enabled) end(); }, [enabled, end]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const active = drag.current;
      if (!active || event.pointerId !== active.pointer) return;
      if (!allowed.current || !active.source.isConnected) { end(); return; }
      if (!active.preview) {
        if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < 6) return;
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
    const cancel = (event: PointerEvent) => { if (event.pointerId === drag.current?.pointer) end(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') end(); };
    const down = () => { suppressClick.current = false; };
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
  }, [end]);
  const start = (event: ReactPointerEvent<HTMLElement>, card: DragCard) => {
    suppressClick.current = false;
    if (!enabled || event.button !== 0 || event.isPrimary === false ||
        (event.target as HTMLElement).closest('button, input, select, a')) return;
    end();
    const source = event.currentTarget, rect = source.getBoundingClientRect();
    drag.current = { ...card, pointer: event.pointerId, source, x: event.clientX, y: event.clientY,
      offsetX: event.clientX - rect.left, offsetY: event.clientY - rect.top,
      width: rect.width, height: rect.height, preview: null };
    source.setPointerCapture?.(event.pointerId);
  };
  return { start, end };
}
