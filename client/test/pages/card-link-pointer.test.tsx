import { fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useCardPointerDrag } from '../../src/card-link/useCardPointerDrag';

function Fixture({ context = 'a:0', enabled = true, drop }: { context?: string; enabled?: boolean; drop: Parameters<typeof useCardPointerDrag>[2] }) {
  const drag = useCardPointerDrag(context, enabled, drop);
  return <><article data-testid="card" data-cl-card="2" onPointerDown={e => drag.start(e, { id: 2, kind: 'hand' })}>
    Player <button>Action</button></article><div data-testid="zone" data-cl-drop-index="1">Slot</div></>;
}
beforeEach(() => {
  class Pointer extends MouseEvent { pointerId = 1; isPrimary = true; }
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
    fireEvent.pointerDown(screen.getByRole('button'), { button: 0 });
    fireEvent.pointerMove(window, { clientX: 50 }); fireEvent.pointerUp(window);
    fireEvent.pointerDown(screen.getByTestId('card'), { button: 0, clientX: 10 }); fireEvent.pointerUp(window);
    begin(); vi.mocked(document.elementFromPoint).mockReturnValue(null); fireEvent.pointerUp(window);
    mounted.rerender(<Fixture enabled={false} drop={drop} />); begin(); fireEvent.pointerUp(window);
    expect(drop).not.toHaveBeenCalled();
    expect(document.querySelector('.cl-card-drag-preview')).toBeNull();
  });
});
