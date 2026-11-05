import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LocationBatchCapture from '../../src/components/admin/LocationBatchCapture';
import { renderWithProviders } from '../render';
import type { CaptureDraft, MapDefinition, Question } from '../../src/location/types';

const { get, post, patch } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  patch: vi.fn(),
}));
vi.mock('../../src/location/api', () => ({
  api: { get, post, patch },
  message: () => '网络中断',
}));
const map: MapDefinition = {
  id: 'de_nuke',
  name: 'Nuke',
  enabled: true,
  order: 0,
  version: 1,
  width: 1024,
  height: 1024,
  floors: [
    { id: 'upper', name: 'Upper', radarUrl: '/nuke.webp' },
    { id: 'lower', name: 'Lower', radarUrl: '/nuke-lower.webp' },
  ],
  bounds: { u: 0, v: 0, width: 1, height: 1 },
  calibration: { posX: 0, posY: 1024, scale: 1, points: [] },
};
const draft = (order: number, floorId = 'upper'): CaptureDraft => ({
  id: `point-${order}`,
  batchId: 'batch-1',
  batchName: '采集一',
  order,
  capturePointId: `tx-test-${order}`,
  mapId: map.id,
  floorId,
  u: 0.2 * order,
  v: 0.4,
  version: 1,
  mapVersion: 1,
  createdAt: '2026-10-17T00:00:00Z',
});
class TestPointer extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number }) {
    super(type, init);
    this.pointerId = init.pointerId || 1;
  }
}
beforeEach(() => {
  get.mockReset();
  post.mockReset();
  patch.mockReset();
  get.mockResolvedValue({ data: { items: [] } });
  vi.stubGlobal('PointerEvent', TestPointer);
  Element.prototype.setPointerCapture = vi.fn();
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  File.prototype.arrayBuffer = async () => new ArrayBuffer(4);
});
function tap(area: HTMLElement, x: number, y: number) {
  vi.spyOn(area, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    x: 0,
    y: 0,
    width: 400,
    height: 400,
    right: 400,
    bottom: 400,
    toJSON: () => ({}),
  });
  fireEvent.pointerDown(area, { pointerId: 1, clientX: x, clientY: y });
  fireEvent.pointerUp(area, { pointerId: 1, clientX: x, clientY: y });
}
describe('batch capture authoring', () => {
  it('keeps batch colors and identities consistent while filtering duplicate point numbers', async () => {
    const a = draft(1);
    const b = { ...draft(2), order: 1, batchId: 'batch-2', batchName: a.batchName };
    get.mockResolvedValue({ data: { items: [a, b] } });
    const { container, unmount } = renderWithProviders(<LocationBatchCapture maps={[map]} onEdit={vi.fn()} />);
    await screen.findAllByRole('button', { name: '采集点 1' });
    const pins = () => [...container.querySelectorAll<HTMLElement>('.location-capture-pin')];
    const colors = pins().map((pin) => pin.style.getPropertyValue('--capture-batch-color'));
    expect(colors[0]).not.toBe(colors[1]);
    expect(pins()[0].title).toContain(a.batchId);
    expect(pins()[1].title).toContain(b.batchId);
    const rows = container.querySelectorAll<HTMLElement>('.location-batch-point');
    expect(rows[0].style.getPropertyValue('--capture-batch-color')).toBe(colors[0]);
    expect(rows[1].style.getPropertyValue('--capture-batch-color')).toBe(colors[1]);
    fireEvent.click(pins()[1]);
    expect(pins()[1]).toHaveClass('selected');
    expect(pins()[1].style.getPropertyValue('--capture-batch-color')).toBe(colors[1]);
    fireEvent.change(screen.getByLabelText('查看批次'), { target: { value: b.batchId } });
    expect(screen.getByRole('button', { name: '连续标点' })).toHaveAttribute('aria-pressed', 'false');
    expect(pins()).toHaveLength(1);
    expect(pins()[0].style.getPropertyValue('--capture-batch-color')).toBe(colors[1]);
    fireEvent.click(screen.getByRole('button', { name: '全部批次' }));
    expect(pins()).toHaveLength(2);
    expect(pins().map((pin) => pin.style.getPropertyValue('--capture-batch-color'))).toEqual(colors);
    unmount();
    get.mockResolvedValue({ data: { items: [b, a] } });
    const reopened = renderWithProviders(<LocationBatchCapture maps={[map]} onEdit={vi.fn()} />);
    await screen.findAllByRole('button', { name: '采集点 1' });
    expect([...reopened.container.querySelectorAll<HTMLElement>('.location-capture-pin')]
      .map((pin) => pin.style.getPropertyValue('--capture-batch-color'))).toEqual([...colors].reverse());
  });
  it('highlights empty points and remaining images, then clears the ring when the last image becomes a question', async () => {
    const asset = { url: '/image.webp', thumbnailUrl: '/thumb.webp', hash: 'hash' };
    const empty = draft(1);
    const legacyImage = { ...draft(2), asset };
    const completed = draft(3);
    const partial = { ...draft(4), images: [{ id: 'remaining-image', asset, createdAt: draft(4).createdAt }] };
    const question = (point: CaptureDraft): Question => ({
      ...point, id: `question-${point.id}`, tier: 'easy', imageUrl: asset.url,
      thumbnailUrl: asset.thumbnailUrl, imageHash: asset.hash, status: 'draft',
      capturedAt: point.createdAt, build: 'test', source: 'test',
    });
    const questions = [question(completed), question(partial), { ...question(empty), mapId: 'another-map' }];
    get.mockResolvedValue({ data: { items: [empty, legacyImage, completed, partial] } });
    const view = renderWithProviders(<LocationBatchCapture maps={[map]} onEdit={vi.fn()} questions={questions} />);
    const emptyPin = await screen.findByRole('button', { name: '采集点 1' });
    expect(emptyPin).toHaveClass('capture-empty');
    expect(screen.getByRole('button', { name: '采集点 2' })).toHaveClass('capture-awaiting-question');
    expect(screen.getByRole('button', { name: '采集点 3' })).toHaveClass('capture-complete');
    expect(screen.getByRole('button', { name: '采集点 4' })).toHaveClass('capture-awaiting-question');
    get.mockResolvedValue({ data: { items: [empty, draft(2), completed, partial] } });
    view.rerender(<LocationBatchCapture maps={[map]} onEdit={vi.fn()} questions={[...questions, question(legacyImage)]} revision={1} />);
    await waitFor(() => expect(screen.getByRole('button', { name: '采集点 2' })).toHaveClass('capture-complete'));
    expect(screen.getByRole('button', { name: '采集点 2' })).not.toHaveClass('capture-empty', 'capture-awaiting-question');
  });
  it('adds several numbered points, restores unsaved work, then persists without images or difficulty', async () => {
    const first = renderWithProviders(
      <LocationBatchCapture maps={[map]} onEdit={vi.fn()} />
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    tap(first.container.querySelector('.location-radar-area')!, 80, 160);
    tap(first.container.querySelector('.location-radar-area')!, 240, 280);
    expect(
      screen.getByRole('button', { name: '采集点 1' })
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '采集点 2' })
    ).toBeInTheDocument();
    first.unmount();
    renderWithProviders(<LocationBatchCapture maps={[map]} onEdit={vi.fn()} />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '保存 2 个待采集点' })
      ).toBeEnabled()
    );
    post.mockImplementation(async (_path, input) => ({
      data: {
        items: input.points.map((p: CaptureDraft) => ({
          ...p,
          version: 1,
          mapVersion: 1,
          createdAt: new Date().toISOString(),
        })),
      },
    }));
    fireEvent.click(screen.getByRole('button', { name: '保存 2 个待采集点' }));
    await screen.findByText('已保存 2 个采集点，可稍后回来配图。');
    const points = post.mock.calls[0][1].points;
    expect(points[0]).toMatchObject({
      mapId: map.id,
      floorId: 'upper',
      u: 0.2,
      v: 0.4,
    });
    expect(points[1]).toMatchObject({ u: 0.6, v: 0.7 });
    expect(points[0]).not.toHaveProperty('tier');
    expect(points[0]).not.toHaveProperty('imageUrl');
    expect(
      JSON.parse(localStorage.getItem('tuxun:capture-points:v2')!)
    ).toEqual([]);
  });
  it('selects existing points without adding a point and respects floors', async () => {
    get.mockResolvedValue({ data: { items: [draft(1), draft(2, 'lower')] } });
    const edit = vi.fn();
    renderWithProviders(<LocationBatchCapture maps={[map]} onEdit={edit} />);
    const marker = await screen.findByRole('button', { name: '采集点 1' });
    expect(
      screen.queryByRole('button', { name: '采集点 2' })
    ).not.toBeInTheDocument();
    fireEvent.pointerDown(marker, { pointerId: 1 });
    fireEvent.pointerUp(marker, { pointerId: 1 });
    fireEvent.click(marker);
    expect(
      screen.getByRole('button', { name: '保存 0 个待采集点' })
    ).toBeDisabled();
    expect(screen.getByRole('button', { name: '完善此题信息' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('选择楼层'), {
      target: { value: 'lower' },
    });
    expect(
      screen.getByRole('button', { name: '采集点 2' })
    ).toBeInTheDocument();
    expect(edit).not.toHaveBeenCalled();
  });
  it('requires explicit image matches and preserves successful bindings when another upload fails', async () => {
    get.mockResolvedValue({ data: { items: [draft(1), draft(2)] } });
    const append = async (url: string, input: any) => {
      if (url.endsWith('/assets')) return { data: { url: '/image.webp', thumbnailUrl: '/thumb.webp', hash: 'hash', width: 360, height: 360 } };
      if (url.includes('point-2')) throw new Error('network');
      return { data: { ...draft(1), version: 2, images: [{ id: input.imageId, asset: input.asset, createdAt: new Date().toISOString() }] } };
    };
    post.mockImplementation(append);
    renderWithProviders(<LocationBatchCapture maps={[map]} onEdit={vi.fn()} />);
    await screen.findByRole('button', { name: '采集点 1' });
    fireEvent.change(
      screen.getByLabelText('批量选择截图', { selector: 'input' }),
      {
        target: {
          files: [
            new File(['a'], '001.png', { type: 'image/png' }),
            new File(['b'], '002.png', { type: 'image/png' }),
          ],
        },
      }
    );
    expect(
      screen.getByRole('button', { name: '确认并保存配图' })
    ).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '按当前点号顺序分配' }));
    fireEvent.click(screen.getByRole('button', { name: '确认并保存配图' }));
    await screen.findByText(
      '本次已配图 1 张；失败的项目保留在下方，可修改后重试。'
    );
    expect(screen.queryByAltText('001.png')).not.toBeInTheDocument();
    expect(screen.getByAltText('002.png')).toBeInTheDocument();
    const uploaded = post.mock.calls.filter(([url]) => url.endsWith('/assets')).length;
    post.mockImplementation(async (url, input) => ({ data: { ...draft(2), version: 2, images: [{ id: input.imageId, asset: input.asset, createdAt: new Date().toISOString() }] } }));
    fireEvent.click(screen.getByRole('button', { name: '确认并保存配图' }));
    await waitFor(() =>
      expect(screen.queryByAltText('002.png')).not.toBeInTheDocument()
    );
    expect(post.mock.calls.filter(([url]) => url.endsWith('/assets'))).toHaveLength(uploaded);
    expect(post.mock.calls.find(([url]) => url.endsWith('/images'))![1].asset).not.toHaveProperty('width');
  });
  it('matches suffixed filenames and appends two images to one point with fresh versions', async () => {
    get.mockResolvedValue({ data: { items: [draft(1)] } });
    let savedPoint = draft(1);
    let uploaded = 0;
    post.mockImplementation(async (url, input) => {
      if (url.endsWith('/assets')) {
        uploaded++;
        return { data: { url: `/image-${uploaded}.webp`, thumbnailUrl: `/thumb-${uploaded}.webp`, hash: `hash-${uploaded}` } };
      }
      expect(input.version).toBe(savedPoint.version);
      savedPoint = { ...savedPoint, version: savedPoint.version + 1, images: [...(savedPoint.images || []), { id: input.imageId, asset: input.asset, createdAt: new Date().toISOString() }] };
      return { data: savedPoint };
    });
    const edit = vi.fn();
    renderWithProviders(<LocationBatchCapture maps={[map]} onEdit={edit} />);
    await screen.findByRole('button', { name: '采集点 1' });
    fireEvent.change(
      screen.getByLabelText('批量选择截图', { selector: 'input' }),
      { target: { files: [new File(['a'], 'tx-test-1__easy.png', { type: 'image/png' }), new File(['b'], 'tx-test-1__hard.png', { type: 'image/png' })] } }
    );
    screen.getAllByLabelText('对应采集点').forEach(select => expect(select).toHaveValue('point-1'));
    expect(
      screen.getByRole('button', { name: '确认并保存配图' })
    ).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: '确认并保存配图' }));
    await screen.findByText('本次已配图 2 张；失败的项目保留在下方，可修改后重试。');
    fireEvent.click(screen.getByRole('button', { name: '采集点 1' }));
    expect(screen.getByRole('button', { name: '选择第 1 张图片' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '选择第 2 张图片' }));
    fireEvent.click(screen.getByRole('button', { name: '完善此题信息' }));
    expect(edit).toHaveBeenCalledWith(savedPoint, savedPoint.images![1].id);
  });
  it('starts a new independent batch without losing unsaved points', async () => {
    const { container } = renderWithProviders(
      <LocationBatchCapture maps={[map]} onEdit={vi.fn()} />
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    tap(container.querySelector('.location-radar-area')!, 80, 160);
    const before = JSON.parse(
      localStorage.getItem('tuxun:capture-points:v2')!
    )[0];
    fireEvent.click(screen.getByRole('button', { name: '新建采集批次' }));
    tap(container.querySelector('.location-radar-area')!, 160, 160);
    const points = JSON.parse(localStorage.getItem('tuxun:capture-points:v2')!);
    expect(points).toHaveLength(2);
    expect(points[0]).toEqual(before);
    expect(points[1].batchId).not.toBe(points[0].batchId);
    expect(points[1].order).toBe(1);
    expect(points[1].capturePointId).not.toBe(points[0].capturePointId);
    const pins = container.querySelectorAll<HTMLElement>('.location-capture-pin');
    expect(pins[0].style.getPropertyValue('--capture-batch-color'))
      .not.toBe(pins[1].style.getPropertyValue('--capture-batch-color'));
    fireEvent.change(screen.getByLabelText('查看批次'), { target: { value: points[0].batchId } });
    expect(container.querySelectorAll('.location-capture-pin')).toHaveLength(1);
    expect(container.querySelector('.location-capture-pin')).toHaveAttribute('title', expect.stringContaining(points[0].capturePointId));
  });
  it('reconciles an uncertain point save with the server when reopening the page', async () => {
    const { container, unmount } = renderWithProviders(
      <LocationBatchCapture maps={[map]} onEdit={vi.fn()} />
    );
    await waitFor(() => expect(get).toHaveBeenCalled());
    tap(container.querySelector('.location-radar-area')!, 80, 160);
    const point = JSON.parse(
      localStorage.getItem('tuxun:capture-points:v2')!
    )[0];
    unmount();
    get.mockResolvedValue({
      data: {
        items: [
          {
            ...point,
            version: 1,
            mapVersion: 1,
            createdAt: new Date().toISOString(),
          },
        ],
      },
    });
    renderWithProviders(<LocationBatchCapture maps={[map]} onEdit={vi.fn()} />);
    await waitFor(() =>
      expect(
        screen.getByRole('button', { name: '保存 0 个待采集点' })
      ).toBeDisabled()
    );
    expect(screen.getAllByRole('button', { name: '采集点 1' })).toHaveLength(1);
  });
});
