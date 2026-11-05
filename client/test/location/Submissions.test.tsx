import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import LocationMenu from '../../src/pages/LocationMenu';
import LocationSubmission from '../../src/pages/LocationSubmission';
import SubmissionManager from '../../src/components/admin/location/SubmissionManager';
import Leaderboard from '../../src/pages/Leaderboard';
import type { MapDefinition } from '../../src/location/types';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/api/client', () => ({ api: { get, post }, errMsg: () => '请求失败' }));
vi.mock('../../src/location/api', () => ({ api: { get, post }, message: () => '请求失败' }));
vi.mock('../../src/location/Radar', () => ({ default: ({ map, floorId, onChange, markers = [], onMarkerSelect }: any) => <>
  <button type="button" disabled={!onChange} onClick={() => onChange?.({ mapId: map.id, floorId, u: .2, v: .4 })}>模拟标点</button>
  {markers.map((p: any) => <button key={p.id} onClick={() => onMarkerSelect?.(p.id)}>{p.ariaLabel}</button>)}
</> }));
vi.mock('../../src/location/Components', () => ({ Photo: ({ url }: any) => <img src={url} alt="审核截图" /> }));
const map: MapDefinition = { id: 'de_dust2', name: 'Dust2', enabled: true, order: 0, version: 3, width: 1024, height: 1024,
  floors: [{ id: 'main', name: 'Main', radarUrl: '/radar.webp' }], bounds: { u: 0, v: 0, width: 1, height: 1 },
  calibration: { posX: 0, posY: 1024, scale: 1, points: [] } };
const submission = { id: 'd7557cf3-9573-4e27-b5a5-ac4f54bda4a4', mapId: map.id, floorId: 'main', u: .5, v: .6, mapVersion: 3,
  submitterName: '游客#ABCDE', imageUrl: '/pending.webp', thumbnailUrl: '/pending-thumb.webp', imageHash: 'a'.repeat(64), note: '墙面细节', createdAt: '2026-10-19T10:00:00Z' };

function uploadFile(name: string) {
  const file = new File(['pixels'], name, { type: 'image/png' });
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
  return file;
}
beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockImplementation(async (url: string) => ({ data: url === '/location/maps' ? [map] : { items: [], total: 0, page: 1, pageSize: 12 } }));
});

describe('community question UI', () => {
  it('places a small submission link below location modes', () => {
    renderAtRoute(<LocationMenu />);
    expect(screen.getByRole('link', { name: '图寻题目投稿' })).toHaveAttribute('href', '/entertainment/location/submit');
  });
  it('shows persistent rules for guests and requires a cropped image and object pin before submission', async () => {
    class PreviewImage {
      naturalWidth = 1920; naturalHeight = 1080; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_url: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', PreviewImage);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
    try {
      post.mockResolvedValue({ data: { status: 'pending' } });
      renderAtRoute(<LocationSubmission />);
      const rules = screen.getByRole('complementary', { name: '出题规则与注意事项' });
      expect(within(rules).getByText(/格洛克/)).toBeInTheDocument();
      expect(within(rules).getByText(/摄影师所处的位置/)).toBeInTheDocument();
      expect(within(rules).getByText(/准星不要过大/)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: '提交投稿' })).toBeDisabled();
      await screen.findByRole('button', { name: '模拟标点' });
      const file = new File(['image pixels'], 'test.png', { type: 'image/png' });
      Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer });
      await userEvent.upload(screen.getByLabelText('选择或拖拽截图'), file);
      await userEvent.click(screen.getByRole('button', { name: '模拟标点' }));
      await waitFor(() => expect(screen.getByRole('button', { name: '提交投稿' })).toBeEnabled());
      await userEvent.click(screen.getByRole('button', { name: '提交投稿' }));
      expect(await screen.findByText(/投稿已收到/)).toBeInTheDocument();
      expect(post).toHaveBeenCalledWith('/location/submissions', expect.any(ArrayBuffer), expect.objectContaining({
        headers: { 'Content-Type': 'image/png' }, params: expect.objectContaining({ mapId: map.id, floorId: 'main', u: .2, v: .4, mapVersion: 3 }),
      }));
      expect(post.mock.calls[0][2].params).not.toHaveProperty('tier');
      expect(rules).toBeInTheDocument();
    } finally { vi.unstubAllGlobals(); }
  });
  it('requires admin difficulty and verification, supports correcting a pin and refreshes normal question management', async () => {
    get.mockResolvedValue({ data: { items: [submission], total: 1, page: 1, pageSize: 12 } });
    post.mockResolvedValue({ data: { accepted: true } }); const onChanged = vi.fn().mockResolvedValue(undefined);
    renderAtRoute(<SubmissionManager maps={[map]} onChanged={onChanged} />);
    await userEvent.click(await screen.findByRole('button', { name: '审核截图与标点' }));
    const approve = screen.getByRole('button', { name: '采纳并发布' }); expect(approve).toBeDisabled();
    await userEvent.selectOptions(screen.getByLabelText('管理员指定难度'), 'medium');
    expect(approve).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '模拟标点' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /我已核对截图与标点/ }));
    await userEvent.click(approve);
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith(`/admin/location/submissions/${submission.id}/review`, expect.objectContaining({ decision: 'approve', tier: 'medium', verified: true, u: .2, v: .4 }));
  });
  it('confirms rejection and calls the delete decision without selecting difficulty', async () => {
    get.mockResolvedValue({ data: { items: [submission], total: 1, page: 1, pageSize: 12 } });
    post.mockResolvedValue({ data: { accepted: false } });
    renderAtRoute(<SubmissionManager maps={[map]} onChanged={async () => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: '审核截图与标点' }));
    await userEvent.click(screen.getByRole('button', { name: '拒绝并删除' }));
    expect(post).not.toHaveBeenCalled();
    const dialog = screen.getByRole('alertdialog', { name: '拒绝并删除' });
    await userEvent.click(within(dialog).getByRole('button', { name: '拒绝并删除' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith(`/admin/location/submissions/${submission.id}/review`, { decision: 'reject' }));
  });
  it('adds a guest-inclusive contributor board without a difficulty filter', async () => {
    get.mockResolvedValue({ data: { items: [{ id: 'public-id', displayId: '游客#ABCDE', accepted: 8, rank: 1, me: true }],
      currentUser: { displayId: '游客#ABCDE', accepted: 8, rank: 1 }, page: 1, hasNext: false } });
    renderAtRoute(<Leaderboard />, { route: '/leaderboard?mode=location-contributions', path: '/leaderboard' });
    expect(await screen.findByRole('columnheader', { name: '题目被采纳数' })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: '图寻圣人榜' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByLabelText('难度')).not.toBeInTheDocument();
    expect(get).toHaveBeenCalledWith('/location/submissions/leaderboard', { params: { page: 1 } });
    expect(get).not.toHaveBeenCalledWith('/leaderboard', expect.anything());
  });
});

describe('review into existing points', () => {
  const point = { capturePointId: 'existing-wall', mapId: map.id, floorId: 'main', u: .7, v: .8,
    fingerprint: 'f'.repeat(64), questions: 3, images: 0, thumbnails: ['/existing.webp'], eligible: true };
  function setup() {
    get.mockImplementation(async (url: string) => ({ data: url.endsWith('/submission-points')
      ? { items: [point], mapVersion: map.version }
      : { items: [submission], total: 1, page: 1, pageSize: 12 } }));
    post.mockResolvedValue({ data: { accepted: true } });
    renderAtRoute(<SubmissionManager maps={[map]} onChanged={vi.fn(async () => undefined)} />);
  }
  it('shows/hides existing markers without changing the manual answer or loading points before requested', async () => {
    setup(); await userEvent.click(await screen.findByRole('button', { name: '审核截图与标点' }));
    expect(get.mock.calls.some(([url]) => url.endsWith('/submission-points'))).toBe(false);
    await userEvent.click(screen.getByRole('checkbox', { name: '显示已有点位' }));
    await screen.findByRole('button', { name: '已有点位 #1 · existing-wall' });
    await userEvent.click(screen.getByRole('checkbox', { name: '显示已有点位' }));
    expect(screen.queryByRole('button', { name: '已有点位 #1 · existing-wall' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: '模拟标点' })).toBeEnabled();
    await userEvent.selectOptions(screen.getByLabelText('管理员指定难度'), 'easy');
    await userEvent.click(screen.getByRole('checkbox', { name: /我已核对截图与标点/ }));
    await userEvent.click(screen.getByRole('button', { name: '采纳并发布' }));
    expect(post.mock.calls[0][1]).toMatchObject({ u: submission.u, v: submission.v });
    expect(post.mock.calls[0][1]).not.toHaveProperty('existingPoint');
  });
  it('requires a target, freezes its answer and preserves selection when markers are hidden', async () => {
    setup(); await userEvent.click(await screen.findByRole('button', { name: '审核截图与标点' }));
    await userEvent.click(screen.getByRole('checkbox', { name: '并入已有点位' }));
    await screen.findByRole('button', { name: '已有点位 #1 · existing-wall' });
    await userEvent.selectOptions(screen.getByLabelText('管理员指定难度'), 'hard');
    await userEvent.click(screen.getByRole('checkbox', { name: /我已核对截图与标点/ }));
    expect(screen.getByRole('button', { name: '采纳并发布' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '已有点位 #1 · existing-wall' }));
    expect(screen.getByRole('checkbox', { name: /我已核对截图与标点/ })).not.toBeChecked();
    expect(screen.getByRole('button', { name: '模拟标点' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: '显示已有点位' }));
    expect(screen.getByLabelText('要并入的点位')).toHaveValue(point.capturePointId);
    await userEvent.click(screen.getByRole('checkbox', { name: /我已核对截图与标点/ }));
    await userEvent.click(screen.getByRole('button', { name: '采纳并发布' }));
    await waitFor(() => expect(post).toHaveBeenCalledOnce());
    expect(post.mock.calls[0][1]).toMatchObject({ u: .7, v: .8, tier: 'hard',
      existingPoint: { capturePointId: point.capturePointId, fingerprint: point.fingerprint } });
  });
  it('clears target and verification on floor changes, and restores the manual pin when leaving merge mode', async () => {
    setup(); await userEvent.click(await screen.findByRole('button', { name: '审核截图与标点' }));
    await userEvent.click(screen.getByRole('checkbox', { name: '并入已有点位' }));
    await userEvent.click(await screen.findByRole('button', { name: '已有点位 #1 · existing-wall' }));
    await userEvent.click(screen.getByRole('checkbox', { name: /我已核对截图与标点/ }));
    fireEvent.change(screen.getByLabelText('所属楼层'), { target: { value: '' } });
    expect(screen.getByLabelText('要并入的点位')).toHaveValue('');
    expect(screen.getByRole('checkbox', { name: /我已核对截图与标点/ })).not.toBeChecked();
    await userEvent.click(screen.getByRole('checkbox', { name: '并入已有点位' }));
    expect(screen.getByRole('button', { name: '模拟标点' })).toBeEnabled();
  });
});

describe('batch community submissions', () => {
  beforeEach(() => {
    class PreviewImage {
      naturalWidth = 1920; naturalHeight = 1080; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_url: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', PreviewImage);
    Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:batch-preview') });
    Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('sends multiple images per numbered pin and preserves all assignments across map changes', async () => {
    const secondMap = { ...map, id: 'de_mirage', name: 'Mirage' };
    get.mockImplementation(async (url: string) => ({ data: url === '/location/maps' ? [map, secondMap] : { items: [], total: 0, page: 1, pageSize: 12 } }));
    post.mockResolvedValue({ data: { status: 'pending' } });
    renderAtRoute(<LocationSubmission />);
    await userEvent.click(await screen.findByRole('button', { name: '模拟标点' }));
    await userEvent.upload(screen.getByLabelText('选择或拖拽截图'), [uploadFile('one.png'), uploadFile('two.png')]);
    await userEvent.click(screen.getByRole('button', { name: '模拟标点' }));
    await userEvent.upload(screen.getByLabelText('选择或拖拽截图'), uploadFile('three.png'));
    await userEvent.selectOptions(screen.getByLabelText('所属地图'), 'de_mirage');
    expect(screen.getByRole('button', { name: 'one.png' })).toBeInTheDocument();
    await userEvent.selectOptions(screen.getByLabelText('所属地图'), map.id);
    expect(screen.getByRole('button', { name: '#1 · 2 张' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '#2 · 1 张' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '提交投稿' }));
    await screen.findByText(/本次 3 张投稿已收到/);
    const inputs = post.mock.calls.map(call => call[2].params);
    expect(inputs).toHaveLength(3);
    expect(new Set(inputs.map(input => input.id)).size).toBe(3);
    expect(inputs[0].pointId).toBe(inputs[1].pointId);
    expect(inputs[0].pointId).not.toBe(inputs[2].pointId);
    expect(inputs.every(input => input.mapId === map.id && input.mapVersion === 3)).toBe(true);
    expect(screen.getByRole('button', { name: '提交投稿' })).toBeDisabled();
    // Sending does not reload maps or silently reset the chosen map/floor.
    expect(get.mock.calls.filter(call => call[0] === '/location/maps')).toHaveLength(1);
  });

  it('retains failed and unattempted images, freezes uncertain inputs and retries with the same UUID', async () => {
    post.mockResolvedValueOnce({ data: { status: 'pending' } }).mockRejectedValueOnce(new Error('connection lost'))
      .mockResolvedValue({ data: { status: 'pending' } });
    renderAtRoute(<LocationSubmission />);
    await userEvent.click(await screen.findByRole('button', { name: '模拟标点' }));
    await userEvent.upload(screen.getByLabelText('选择或拖拽截图'), [uploadFile('ok.png'), uploadFile('retry.png'), uploadFile('later.png')]);
    await userEvent.click(screen.getByRole('button', { name: '提交投稿' }));
    await screen.findByText(/本次 1 张投稿已收到/);
    expect(post).toHaveBeenCalledTimes(2);
    const uncertain = post.mock.calls[1][2].params;
    await userEvent.click(screen.getByRole('button', { name: 'retry.png' }));
    expect(screen.getByLabelText('此图对应点位')).toBeDisabled();
    expect(screen.getByRole('button', { name: '调整当前点' })).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: '提交投稿' }));
    await screen.findByText(/本次 2 张投稿已收到/);
    expect(post).toHaveBeenCalledTimes(4);
    expect(post.mock.calls[2][2].params).toEqual(uncertain);
    expect(post.mock.calls[3][2].params.id).not.toBe(post.mock.calls[0][2].params.id);
    expect(screen.getAllByText('已送审')).toHaveLength(3);
  });

  it('stops the batch at a rate limit without dropping or sending the remaining images', async () => {
    post.mockRejectedValue({ response: { status: 429 } });
    renderAtRoute(<LocationSubmission />);
    await userEvent.click(await screen.findByRole('button', { name: '模拟标点' }));
    await userEvent.upload(screen.getByLabelText('选择或拖拽截图'), [uploadFile('limited.png'), uploadFile('retained.png')]);
    await userEvent.click(screen.getByRole('button', { name: '提交投稿' }));
    await screen.findByText(/本次 0 张投稿已收到/);
    expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByText('共 1 个点位，2 张图片待提交。')).toBeInTheDocument();
    expect(screen.getByText('待上传')).toBeInTheDocument();
  });

  it('reassigns an image without moving its siblings, and highlights the new point', async () => {
    renderAtRoute(<LocationSubmission />);
    await userEvent.click(await screen.findByRole('button', { name: '模拟标点' }));
    await userEvent.upload(screen.getByLabelText('选择或拖拽截图'), [uploadFile('stay.png'), uploadFile('move.png')]);
    await userEvent.click(screen.getByRole('button', { name: '模拟标点' }));
    await userEvent.click(screen.getByRole('button', { name: 'move.png' }));
    const target = within(screen.getByLabelText('此图对应点位')).getByRole('option', { name: '#2 · Dust2 · 主层' }) as HTMLOptionElement;
    await userEvent.selectOptions(screen.getByLabelText('此图对应点位'), target.value);
    expect(screen.getByRole('button', { name: '#1 · 1 张' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: '#2 · 1 张' })).toHaveAttribute('aria-pressed', 'true');
    await userEvent.click(screen.getByRole('button', { name: 'stay.png' }));
    expect(screen.getByLabelText('此图对应点位')).not.toHaveValue(target.value);
  });

  it('rejects undersized images before uploading and keeps the file for correction', async () => {
    class SmallImage {
      naturalWidth = 200; naturalHeight = 200; onload: (() => void) | null = null; onerror: (() => void) | null = null;
      set src(_url: string) { queueMicrotask(() => this.onload?.()); }
    }
    vi.stubGlobal('Image', SmallImage);
    renderAtRoute(<LocationSubmission />);
    await userEvent.click(await screen.findByRole('button', { name: '模拟标点' }));
    await userEvent.upload(screen.getByLabelText('选择或拖拽截图'), uploadFile('small.png'));
    await userEvent.click(screen.getByRole('button', { name: '提交投稿' }));
    await screen.findByText(/本次 0 张投稿已收到/);
    expect(post).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toBeVisible();
    expect(screen.getByRole('button', { name: 'small.png' })).toBeInTheDocument();
    expect(screen.getByLabelText('此图对应点位')).toBeEnabled();
  });
});
