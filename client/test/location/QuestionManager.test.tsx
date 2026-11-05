import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import QuestionManager from '../../src/components/admin/location/QuestionManager';
import { renderWithProviders } from '../render';
import type { MapDefinition, Question } from '../../src/location/types';

const { post } = vi.hoisted(() => ({ post: vi.fn() }));
vi.mock('../../src/location/api', () => ({ api: { post }, message: () => '网络中断，请重试' }));
const map: MapDefinition = {
  id: 'de_dust2', name: 'Dust2', version: 1, enabled: true, order: 0, width: 1024, height: 1024,
  bounds: { u: 0, v: 0, width: 1, height: 1 },
  floors: [{ id: 'main', name: 'Main', radarUrl: '/dust.webp' }],
  calibration: { posX: 0, posY: 1024, scale: 1, points: [] },
};
const question = (index: number, status: Question['status']): Question => ({
  id: `question-${index}`, version: index + 1, mapVersion: 1, mapId: map.id, floorId: 'main',
  u: .5, v: .5, capturePointId: `point-${index}`, tier: 'easy', status,
  imageUrl: `/image-${index}.webp`, thumbnailUrl: `/thumb-${index}.webp`, imageHash: `hash-${index}`,
  capturedAt: '2026-10-19T00:00:00Z', source: '', build: '',
});
const props = { maps: [map], onEdit: vi.fn(), onNew: vi.fn() };
beforeEach(() => { post.mockReset(); });

class TestPointer extends MouseEvent {
  pointerId: number;
  constructor(type: string, init: MouseEventInit & { pointerId?: number }) {
    super(type, init);
    this.pointerId = init.pointerId || 1;
  }
}

describe('question map area filters', () => {
  const layeredMap = { ...map, floors: [
    { id: 'upper', name: 'Upper', radarUrl: '/upper.webp' },
    { id: 'lower', name: 'Lower', radarUrl: '/lower.webp' },
  ] };
  const otherMap = { ...map, id: 'de_mirage', name: 'Mirage' };
  const questions = [
    { ...question(0, 'published'), floorId: 'upper' },
    { ...question(1, 'published'), floorId: 'upper', u: .25, v: .75 },
    { ...question(2, 'published'), floorId: 'upper', u: .9 },
    { ...question(3, 'published'), floorId: 'lower' },
    { ...question(4, 'published'), mapId: otherMap.id },
    { ...question(5, 'draft'), floorId: 'upper', tier: 'hard' as const, source: 'needle' },
    { ...question(6, 'published'), floorId: 'upper', capturePointId: 'point-0' },
  ];
  beforeEach(() => {
    vi.stubGlobal('PointerEvent', TestPointer);
    Element.prototype.setPointerCapture = vi.fn();
  });
  function renderManager() {
    return renderWithProviders(<QuestionManager {...props} maps={[layeredMap, otherMap]}
      questions={questions} onChanged={vi.fn(async () => undefined)} />);
  }
  function chooseFloor(floor = 'upper') {
    fireEvent.change(screen.getByLabelText('所属地图'), { target: { value: map.id } });
    fireEvent.change(screen.getByLabelText('所属楼层'), { target: { value: floor } });
  }
  function draw(from = [100, 50], to = [300, 150]) {
    const radar = screen.getByRole('group', { name: '框选范围' });
    vi.spyOn(radar, 'getBoundingClientRect').mockReturnValue({
      x: 0, y: 0, left: 0, top: 0, width: 400, height: 200, right: 400, bottom: 200,
      toJSON: () => ({}),
    });
    fireEvent.pointerDown(radar, { pointerId: 1, clientX: from[0], clientY: from[1] });
    fireEvent.pointerMove(radar, { pointerId: 1, clientX: to[0], clientY: to[1] });
    fireEvent.pointerUp(radar, { pointerId: 1, clientX: to[0], clientY: to[1] });
  }
  it('filters by floor and rectangle, includes boundary pins and every image at a shared point', () => {
    const { container } = renderManager();
    expect(screen.getByLabelText('所属楼层')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('所属地图'), { target: { value: map.id } });
    expect(screen.queryByRole('group', { name: '框选范围' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('所属楼层'), { target: { value: 'upper' } });
    draw([300, 150], [100, 50]);
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(4);
    expect(screen.getByText('显示 4 / 7 道题')).toBeInTheDocument();
    expect(screen.getByAltText('point-1')).toBeInTheDocument();
    expect(screen.queryByAltText('point-2')).not.toBeInTheDocument();
    expect(screen.queryByAltText('point-3')).not.toBeInTheDocument();
    expect(screen.queryByAltText('point-4')).not.toBeInTheDocument();
    expect(screen.getAllByAltText('point-0')).toHaveLength(2);
    fireEvent.click(screen.getByRole('button', { name: '拖动地图' }));
    expect(screen.getByLabelText('已选筛选范围')).toBeInTheDocument();
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(4);
    fireEvent.click(screen.getByRole('button', { name: '清除范围' }));
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(5);
    expect(screen.queryByLabelText('已选筛选范围')).not.toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });
  it('combines the area with status, difficulty and text filters and supports an empty result', () => {
    const { container } = renderManager();
    chooseFloor(); draw();
    fireEvent.change(screen.getByLabelText('题目状态'), { target: { value: 'draft' } });
    fireEvent.change(screen.getByLabelText('题目等级'), { target: { value: 'hard' } });
    fireEvent.change(screen.getByLabelText('搜索点号、编号或来源'), { target: { value: 'needle' } });
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(1);
    expect(screen.getByAltText('point-5')).toBeInTheDocument();
    draw([0, 0], [50, 25]);
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(0);
    expect(screen.getByText('显示 0 / 7 道题')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '清除范围' }));
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(1);
  });
  it('clears the old area on map or floor changes, with single-floor maps selected automatically', () => {
    const { container } = renderManager();
    chooseFloor(); draw();
    fireEvent.change(screen.getByLabelText('所属楼层'), { target: { value: 'lower' } });
    expect(screen.queryByLabelText('已选筛选范围')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '清除范围' })).toBeDisabled();
    expect(screen.getByAltText('point-3')).toBeInTheDocument();
    draw([0, 0], [50, 25]);
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(0);
    fireEvent.change(screen.getByLabelText('所属楼层'), { target: { value: 'upper' } });
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(5);
    draw();
    fireEvent.change(screen.getByLabelText('所属地图'), { target: { value: otherMap.id } });
    expect(screen.getByLabelText('所属楼层')).toHaveValue('main');
    expect(screen.queryByLabelText('已选筛选范围')).not.toBeInTheDocument();
    expect(screen.getByAltText('point-4')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('所属地图'), { target: { value: '' } });
    expect(container.querySelectorAll('.location-question-card')).toHaveLength(7);
  });
});

describe('bulk question publication', () => {
  it('publishes all drafts and review-pending questions independently of filters and reports partial success', async () => {
    const questions = [question(0, 'draft'), question(1, 'review'), question(2, 'published'), question(3, 'disabled')];
    let finish!: (result: unknown) => void;
    post.mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const onChanged = vi.fn(async () => undefined);
    renderWithProviders(<QuestionManager {...props} questions={questions} onChanged={onChanged} />);
    fireEvent.change(screen.getByLabelText('题目状态'), { target: { value: 'published' } });
    fireEvent.change(screen.getByLabelText('搜索点号、编号或来源'), { target: { value: 'point-2' } });
    fireEvent.click(screen.getByRole('button', { name: '一键批量发布（2）' }));
    expect(post).toHaveBeenCalledWith('/admin/location/questions/publish', { questions: [
      { id: questions[0].id, version: questions[0].version },
      { id: questions[1].id, version: questions[1].version },
    ] });
    expect(screen.getByRole('button', { name: '正在批量发布…' })).toBeDisabled();
    expect(screen.getByRole('button', { name: '新增题目' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '正在批量发布…' }));
    expect(post).toHaveBeenCalledTimes(1);
    finish({ data: { results: [
      { id: questions[0].id, capturePointId: questions[0].capturePointId, ok: true },
      { id: questions[1].id, capturePointId: questions[1].capturePointId, ok: false, code: 'LOCATION_INVALID_ASSET' },
    ] } });
    await screen.findByText('已发布 1 道，失败 1 道。');
    expect(screen.getByRole('alert')).toHaveTextContent('point-1 · question-1');
    expect(screen.getByRole('alert')).toHaveTextContent('图片格式、文件或哈希无效');
    await waitFor(() => expect(onChanged).toHaveBeenCalledTimes(1));
  });
  it('disables publication for an empty pending box and refreshes after an uncertain network response', async () => {
    const onChanged = vi.fn(async () => undefined);
    const view = renderWithProviders(<QuestionManager {...props} questions={[question(0, 'published')]} onChanged={onChanged} />);
    expect(screen.getByRole('button', { name: '一键批量发布（0）' })).toBeDisabled();
    view.rerender(<QuestionManager {...props} questions={[question(1, 'draft')]} onChanged={onChanged} />);
    post.mockRejectedValueOnce(new Error('network'));
    fireEvent.click(screen.getByRole('button', { name: '一键批量发布（1）' }));
    await screen.findByText('网络中断，请重试');
    expect(onChanged).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '一键批量发布（1）' })).toBeEnabled();
  });
  it('splits large pending boxes into bounded requests and refreshes the list once', async () => {
    const questions = Array.from({ length: 501 }, (_, i) => question(i, 'draft'));
    post.mockImplementation(async (_url, { questions: batch }) => ({ data: {
      results: batch.map(({ id }: { id: string }) => ({ id, capturePointId: id, ok: true })),
    } }));
    const onChanged = vi.fn(async () => undefined);
    renderWithProviders(<QuestionManager {...props} questions={questions} onChanged={onChanged} />);
    fireEvent.click(screen.getByRole('button', { name: '一键批量发布（501）' }));
    await screen.findByText('已发布 501 道，失败 0 道。');
    expect(post.mock.calls.map(([, body]) => body.questions.length)).toEqual([500, 1]);
    expect(onChanged).toHaveBeenCalledTimes(1);
  });
});
