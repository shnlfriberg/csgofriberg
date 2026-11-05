import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuestionManager from '../../src/components/admin/location/QuestionManager';
import { renderWithProviders } from '../render';
import type { MapDefinition, Question } from '../../src/location/types';

const { get } = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('../../src/location/api', () => ({ api: { get }, message: () => '失败' }));
const map: MapDefinition = { id: 'map', name: 'Map', enabled: true, order: 0, version: 1, width: 1024, height: 1024,
  floors: [{ id: 'main', name: 'Main', radarUrl: '/radar.webp' }], bounds: { u: 0, v: 0, width: 1, height: 1 }, calibration: { posX: 0, posY: 1024, scale: 1, points: [] } };
const question = (i: number): Question => ({ id: `q${i}`, mapId: map.id, floorId: 'main', u: .5, v: .5, capturePointId: `point-${i}`,
  version: 1, mapVersion: 1, tier: 'easy', status: 'published', imageUrl: '/full.webp', thumbnailUrl: '/thumb.webp', imageHash: `${i}`, capturedAt: '', build: '', source: '' });
const response = (items: Question[], total: number) => ({ data: { items, total, totalAll: 41, pending: 0, page: 1, pageSize: 40, pointCounts: {} } });
beforeEach(() => { get.mockReset(); });

describe('server paged question workspace', () => {
  it('loads only one page and sends floor and rectangle bounds to the server', async () => {
    get.mockImplementation(async (_url, { params }) => response(params.minU !== undefined ? [question(0)] : params.page === 2 ? [question(40)] : Array.from({ length: 40 }, (_, i) => question(i)), params.minU !== undefined ? 1 : 41));
    const { container } = renderWithProviders(<QuestionManager serverPaged maps={[map]} questions={[]} onEdit={vi.fn()} onNew={vi.fn()} onChanged={vi.fn(async () => undefined)} />);
    await waitFor(() => expect(container.querySelectorAll('.location-question-card')).toHaveLength(40));
    fireEvent.click(screen.getByRole('button', { name: '下一页' }));
    expect(await screen.findByText('point-40')).toBeInTheDocument();
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('所属地图'), { target: { value: map.id } });
    class Pointer extends MouseEvent { pointerId = 1; }
    vi.stubGlobal('PointerEvent', Pointer);
    Element.prototype.setPointerCapture = vi.fn();
    const radar = screen.getByRole('group', { name: '框选范围' });
    vi.spyOn(radar, 'getBoundingClientRect').mockReturnValue({ x: 0, y: 0, left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200, toJSON: () => ({}) });
    fireEvent.pointerDown(radar, { clientX: 100, clientY: 50 });
    fireEvent.pointerUp(radar, { clientX: 300, clientY: 150 });
    await waitFor(() => expect(get).toHaveBeenLastCalledWith('/admin/location/questions', expect.objectContaining({ params: expect.objectContaining({ mapId: 'map', floorId: 'main', minU: .25, minV: .25, maxU: .75, maxV: .75, page: 1 }) })));
    await waitFor(() => expect(container.querySelectorAll('.location-question-card')).toHaveLength(1));
  });
  it('ignores a stale response after a newer search has completed', async () => {
    let stale!: (result: unknown) => void;
    get.mockImplementationOnce(() => new Promise(resolve => { stale = resolve; }))
      .mockImplementation(async () => response([question(2)], 1));
    renderWithProviders(<QuestionManager serverPaged maps={[map]} questions={[]} onEdit={vi.fn()} onNew={vi.fn()} onChanged={vi.fn(async () => undefined)} />);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'new' } });
    expect(await screen.findByText('point-2')).toBeInTheDocument();
    stale(response([question(1)], 1));
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(screen.queryByText('point-1')).not.toBeInTheDocument();
    expect(screen.getByText('point-2')).toBeInTheDocument();
  });
});
