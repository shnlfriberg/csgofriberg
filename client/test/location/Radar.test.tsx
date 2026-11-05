import { fireEvent, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Radar from '../../src/location/Radar';
import { QuestionPanel } from '../../src/location/Components';
import type { MapDefinition } from '../../src/location/types';
import { renderWithProviders } from '../render';

const map: MapDefinition = {
  id: 'de_nuke',
  name: 'Nuke',
  enabled: true,
  order: 0,
  version: 1,
  width: 1024,
  height: 512,
  bounds: { u: 0, v: 0, width: 1, height: 1 },
  floors: [
    { id: 'upper', name: 'upper', radarUrl: '/nuke-upper.webp' },
    { id: 'lower', name: 'lower', radarUrl: '/nuke-lower.webp' },
  ],
  calibration: { posX: 0, posY: 0, scale: 1, points: [] },
};
class TestPointer extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number }) {
    super(type, init);
    this.pointerId = init.pointerId || 1;
  }
}
beforeEach(() => {
  vi.stubGlobal('PointerEvent', TestPointer);
  Element.prototype.setPointerCapture = vi.fn();
  HTMLDialogElement.prototype.close = vi.fn();
});
function rectangle(width = 400, height = 200) {
  return {
    left: 0,
    top: 0,
    x: 0,
    y: 0,
    width,
    height,
    right: width,
    bottom: height,
    toJSON: () => ({}),
  };
}
function tap(area: HTMLElement, x: number, y: number) {
  fireEvent.pointerDown(area, { pointerId: 1, clientX: x, clientY: y });
  fireEvent.pointerUp(area, { pointerId: 1, clientX: x, clientY: y });
}
describe('intrinsic radar coordinates', () => {
  it('draws normalized rectangles in either direction after zooming and panning', () => {
    const selected = vi.fn();
    const view = renderWithProviders(<Radar map={map} floorId="upper" onSelectArea={selected} />);
    const area = screen.getByRole('group', { name: '框选范围' });
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(rectangle());
    fireEvent.click(screen.getByRole('button', { name: '放大雷达' }));
    fireEvent.pointerDown(area, { pointerId: 1, clientX: 335, clientY: 167.5 });
    fireEvent.pointerMove(area, { pointerId: 1, clientX: 65, clientY: 32.5 });
    expect(screen.getByLabelText('已选筛选范围')).toBeInTheDocument();
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 65, clientY: 32.5 });
    expect(selected).toHaveBeenLastCalledWith({ minU: .25, minV: .25, maxU: .75, maxV: .75 });

    view.rerender(<Radar map={map} floorId="upper" />);
    fireEvent.pointerDown(area, { pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(area, { pointerId: 1, clientX: 254, clientY: 127 });
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 254, clientY: 127 });
    view.rerender(<Radar map={map} floorId="upper" onSelectArea={selected} />);
    fireEvent.pointerDown(area, { pointerId: 1, clientX: 92, clientY: 46 });
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 308, clientY: 154 });
    const last = selected.mock.calls.at(-1)![0];
    expect(last.minU).toBeCloseTo(.2); expect(last.minV).toBeCloseTo(.2);
    expect(last.maxU).toBeCloseTo(.6); expect(last.maxV).toBeCloseTo(.6);
  });

  it('clamps rectangles to the map and ignores taps, cancelled gestures and multi-touch', () => {
    const selected = vi.fn();
    renderWithProviders(<Radar map={map} floorId="upper" onSelectArea={selected} />);
    const area = screen.getByRole('group', { name: '框选范围' });
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(rectangle());
    tap(area, 100, 50);
    fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerMove(area, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerCancel(area, { pointerId: 1, clientX: 300, clientY: 150 });
    expect(screen.queryByLabelText('已选筛选范围')).not.toBeInTheDocument();
    fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.keyDown(area, { key: 'Escape' });
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 300, clientY: 150 });
    fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerDown(area, { pointerId: 2, clientX: 300, clientY: 150 });
    fireEvent.pointerUp(area, { pointerId: 2, clientX: 350, clientY: 180 });
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 200, clientY: 100 });
    expect(selected).not.toHaveBeenCalled();
    fireEvent.pointerDown(area, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 600, clientY: 300 });
    expect(selected).toHaveBeenCalledWith({ minU: .25, minV: .25, maxU: 1, maxV: 1 });
  });

  it('preserves a point through zoom and viewport changes and distinguishes a drag from a tap', () => {
    const changed = vi.fn();
    const { container } = renderWithProviders(
      <Radar map={map} floorId="upper" onChange={changed} />
    );
    const area = container.querySelector('.location-radar-area') as HTMLElement;
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(rectangle());
    tap(area, 200, 100);
    expect(changed).toHaveBeenLastCalledWith({
      mapId: map.id,
      floorId: 'upper',
      u: 0.5,
      v: 0.5,
    });
    fireEvent.click(screen.getByRole('button', { name: '放大雷达' }));
    tap(area, 200, 100);
    expect(changed.mock.calls.at(-1)![0].u).toBeCloseTo(0.5);
    expect(changed.mock.calls.at(-1)![0].v).toBeCloseTo(0.5);
    const calls = changed.mock.calls.length;
    fireEvent.pointerDown(area, { pointerId: 1, clientX: 200, clientY: 100 });
    fireEvent.pointerMove(area, { pointerId: 1, clientX: 260, clientY: 120 });
    fireEvent.pointerUp(area, { pointerId: 1, clientX: 260, clientY: 120 });
    expect(changed).toHaveBeenCalledTimes(calls);
    fireEvent.click(screen.getByRole('button', { name: '回到全图' }));
    vi.mocked(area.getBoundingClientRect).mockReturnValue(rectangle(800, 400));
    tap(area, 400, 200);
    expect(changed).toHaveBeenLastCalledWith({
      mapId: map.id,
      floorId: 'upper',
      u: 0.5,
      v: 0.5,
    });
  });
  it('requires an explicit floor and clears the old pin when the map changes', () => {
    const single = {
      ...map,
      id: 'de_cache',
      name: 'Cache',
      floors: [{ id: 'main', name: 'main', radarUrl: '/cache.webp' }],
    };
    const submitted = vi.fn();
    const { container } = renderWithProviders(
      <QuestionPanel
        imageUrl="/test.webp"
        maps={[map, single]}
        onSubmit={submitted}
      />
    );
    fireEvent.click(screen.getByRole('button', { name: '核子危机 Nuke' }));
    expect(container.querySelector('.location-radar-area')).toBeNull();
    expect(screen.getByRole('button', { name: '提交本轮答案' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '上层' }));
    const area = container.querySelector('.location-radar-area') as HTMLElement;
    vi.spyOn(area, 'getBoundingClientRect').mockReturnValue(rectangle());
    tap(area, 100, 50);
    expect(screen.getByRole('button', { name: '提交本轮答案' })).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '死城之谜 Cache' }));
    expect(screen.getByRole('button', { name: '提交本轮答案' })).toBeDisabled();
    expect(screen.queryByLabelText('你的落点')).not.toBeInTheDocument();
  });
});
