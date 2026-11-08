import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCardPointerDrag } from '../../src/card-link/useCardPointerDrag';

function Fixture({ context = 'a:0', enabled = true, visible = true, kind = 'hand', drop }: {
  context?: string; enabled?: boolean; visible?: boolean; kind?: 'hand' | 'search' | 'board';
  drop: Parameters<typeof useCardPointerDrag>[2];
}) {
  const drag = useCardPointerDrag(context, enabled, drop);
  return <>{(visible ? [2, 3] : [3]).map(id => <article key={id} data-testid={id === 2 ? 'card' : 'other'} data-cl-card={id}
    data-cl-touch-selected={drag.touchSelected?.id === id ? '' : undefined}
    onPointerDown={e => drag.start(e, { id, kind })}>
    Player <button>Action {id}</button></article>)}<div data-testid="zone" data-cl-drop-index="1">Slot</div></>;
}
beforeEach(() => {
  class Pointer extends MouseEvent {
    pointerId: number; isPrimary: boolean; pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.isPrimary = init.isPrimary ?? true;
      this.pointerType = init.pointerType ?? 'mouse';
    }
  }
  vi.stubGlobal('PointerEvent', Pointer);
  Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: vi.fn(() => screen.getByTestId('zone')) });
});
afterEach(() => vi.unstubAllGlobals());
const begin = () => {
  fireEvent.pointerDown(screen.getByTestId('card'), { button: 0, clientX: 10, clientY: 20 });
  fireEvent.pointerMove(window, { clientX: 50, clientY: 60 });
};
describe('card pointer dragging', () => {
  it('moves with pointer input, submits once, and does not depend on native DataTransfer', () => {
    const drop = vi.fn(); render(<Fixture drop={drop} />);
    begin();
    expect(document.querySelector('.cl-card-drag-preview')).toHaveStyle({ pointerEvents: 'none' });
    expect(screen.getByTestId('zone')).toHaveClass('cl-drop-target');
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
    expect(drop).toHaveBeenCalledTimes(1);
    expect(drop).toHaveBeenCalledWith(expect.objectContaining({ id: 2, kind: 'hand' }), 1);
    expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
    expect(screen.getByTestId('zone')).not.toHaveClass('cl-drop-target');
  });
  it('cleans cancelled and old-game drags and permits dragging immediately in the new game', () => {
    const drop = vi.fn(), mounted = render(<Fixture drop={drop} />);
    begin(); mounted.rerender(<Fixture context="b:0" drop={drop} />);
    fireEvent.pointerUp(window, { clientX: 50, clientY: 60 });
    expect(drop).not.toHaveBeenCalled();
    expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
    begin(); fireEvent.pointerCancel(window); expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
    begin(); fireEvent.pointerUp(window, { clientX: 50, clientY: 60 }); expect(drop).toHaveBeenCalledTimes(1);
    begin(); mounted.unmount(); expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
  });
  it('ignores action buttons, clicks, outside drops and disabled games', () => {
    const drop = vi.fn(), mounted = render(<Fixture drop={drop} />);
    fireEvent.pointerDown(screen.getByRole('button', { name: 'Action 2' }), { button: 0 });
    fireEvent.pointerMove(window, { clientX: 50 }); fireEvent.pointerUp(window);
    fireEvent.pointerDown(screen.getByTestId('card'), { button: 0, clientX: 10 }); fireEvent.pointerUp(window);
    begin(); vi.mocked(document.elementFromPoint).mockReturnValue(null); fireEvent.pointerUp(window);
    mounted.rerender(<Fixture enabled={false} drop={drop} />); begin(); fireEvent.pointerUp(window);
    expect(drop).not.toHaveBeenCalled();
    expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
  });
});

const touch = { pointerType: 'touch', pointerId: 7, button: 0, clientX: 10, clientY: 20 };
const tapCard = (testId = 'card') => {
  fireEvent.pointerDown(screen.getByTestId(testId), touch);
  fireEvent.pointerUp(screen.getByTestId(testId), touch);
};
describe('touch hand selection and scrolling', () => {
  it.each(['hand', 'search'] as const)('leaves %s swipes to the browser without capturing, selecting or playing', kind => {
    const drop = vi.fn(); render(<Fixture kind={kind} drop={drop} />);
    const card = screen.getByTestId('card');
    card.setPointerCapture = vi.fn();
    expect(fireEvent.pointerDown(card, touch)).toBe(true);
    expect(fireEvent.pointerMove(card, { ...touch, clientX: 90 })).toBe(true);
    fireEvent.pointerMove(card, touch); // Returning to the start must not turn a swipe into a tap.
    fireEvent.pointerUp(card, touch);
    expect(card.setPointerCapture).not.toHaveBeenCalled();
    expect(card).not.toHaveAttribute('data-cl-touch-selected');
    expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
    expect(drop).not.toHaveBeenCalled();
  });
  it.each(['hand', 'search'] as const)('requires a separate tap before dragging a %s card, and plays exactly once', kind => {
    const drop = vi.fn(); render(<Fixture kind={kind} drop={drop} />);
    const card = screen.getByTestId('card');
    tapCard();
    expect(card).toHaveAttribute('data-cl-touch-selected');
    expect(drop).not.toHaveBeenCalled();
    expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
    fireEvent.pointerDown(card, touch);
    fireEvent.pointerMove(window, { ...touch, clientX: 90 });
    expect(document.querySelector('.cl-card-drag-preview')).not.toBeNull();
    fireEvent.pointerUp(window, { ...touch, clientX: 90 });
    fireEvent.pointerUp(window, { ...touch, clientX: 90 });
    expect(drop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 2, kind }), 1);
    expect(card).not.toHaveAttribute('data-cl-touch-selected');
    expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
    expect(fireEvent.click(card)).toBe(false); // No synthetic click after dragging.
  });
  it('cancels taps on native scrolling, large release displacement, or a second finger', () => {
    const drop = vi.fn(); render(<Fixture drop={drop} />);
    const card = screen.getByTestId('card');
    fireEvent.pointerDown(card, touch); fireEvent.pointerCancel(card, touch); fireEvent.pointerUp(card, touch);
    expect(card).not.toHaveAttribute('data-cl-touch-selected');
    fireEvent.pointerDown(card, touch); fireEvent.pointerUp(card, { ...touch, clientX: 90 });
    expect(card).not.toHaveAttribute('data-cl-touch-selected');
    fireEvent.pointerDown(card, touch);
    fireEvent.pointerDown(card, { ...touch, pointerId: 8, isPrimary: false });
    fireEvent.pointerUp(card, touch);
    expect(card).not.toHaveAttribute('data-cl-touch-selected');
    tapCard(); fireEvent.pointerDown(card, touch);
    fireEvent.pointerMove(window, { ...touch, clientX: 90 });
    fireEvent.pointerDown(card, { ...touch, pointerId: 8, isPrimary: false });
    fireEvent.pointerUp(window, { ...touch, clientX: 90 });
    expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
    expect(drop).not.toHaveBeenCalled();
  });
  it('switches selection and clears it on outside taps, buttons, cancellation, blur and Escape', () => {
    const drop = vi.fn(); render(<Fixture drop={drop} />);
    tapCard(); tapCard('other');
    expect(screen.getByTestId('card')).not.toHaveAttribute('data-cl-touch-selected');
    expect(screen.getByTestId('other')).toHaveAttribute('data-cl-touch-selected');
    fireEvent.pointerDown(screen.getByTestId('zone'), touch);
    expect(screen.getByTestId('other')).not.toHaveAttribute('data-cl-touch-selected');
    const card = screen.getByTestId('card'), button = screen.getByRole('button', { name: 'Action 2' });
    tapCard(); fireEvent.pointerDown(button, touch); fireEvent.pointerUp(button, touch);
    expect(fireEvent.click(button)).toBe(true);
    expect(card).not.toHaveAttribute('data-cl-touch-selected');
    tapCard(); fireEvent.pointerDown(card, touch); fireEvent.pointerCancel(card, touch);
    expect(card).not.toHaveAttribute('data-cl-touch-selected');
    tapCard(); fireEvent.blur(window);
    expect(card).not.toHaveAttribute('data-cl-touch-selected');
    tapCard(); fireEvent.keyDown(window, { key: 'Escape' });
    expect(card).not.toHaveAttribute('data-cl-touch-selected');
    expect(drop).not.toHaveBeenCalled();
  });
  it('clears selection on a new round, disabled game and removal from the hand', () => {
    const drop = vi.fn(), mounted = render(<Fixture drop={drop} />);
    tapCard(); mounted.rerender(<Fixture context="a:1" drop={drop} />);
    expect(screen.getByTestId('card')).not.toHaveAttribute('data-cl-touch-selected');
    tapCard(); mounted.rerender(<Fixture context="a:1" enabled={false} drop={drop} />);
    expect(screen.getByTestId('card')).not.toHaveAttribute('data-cl-touch-selected');
    tapCard(); expect(screen.getByTestId('card')).not.toHaveAttribute('data-cl-touch-selected');
    mounted.rerender(<Fixture drop={drop} />); tapCard();
    mounted.rerender(<Fixture visible={false} drop={drop} />);
    mounted.rerender(<Fixture drop={drop} />);
    expect(screen.getByTestId('card')).not.toHaveAttribute('data-cl-touch-selected');
    expect(drop).not.toHaveBeenCalled();
  });
  it('keeps direct touch dragging on board cards', () => {
    const drop = vi.fn(); render(<Fixture kind="board" drop={drop} />);
    fireEvent.pointerDown(screen.getByTestId('card'), touch);
    fireEvent.pointerMove(window, { ...touch, clientX: 90 });
    fireEvent.pointerUp(window, { ...touch, clientX: 90 });
    expect(drop).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ id: 2, kind: 'board' }), 1);
  });
});
