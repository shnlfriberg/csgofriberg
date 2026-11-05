import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import Admin from '../../src/pages/Admin';
import AdminLocation from '../../src/components/admin/AdminLocation';
import { renderAtRoute, renderWithProviders } from '../render';
import type { AdminOverview, MapDefinition, Question } from '../../src/location/types';
import { useAuth } from '../../src/store/auth';

vi.mock('../../src/api/socket', () => ({ getSocket: () => ({ on() {}, off() {}, emit() {}, connected: false }) }));
vi.mock('../../src/components/admin/AdminPlayers', () => ({ default: () => <div>Players placeholder</div> }));

const { get, post, put } = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  put: vi.fn(),
}));
vi.mock('../../src/location/api', () => ({
  api: { get, post, put },
  message: () => '操作失败',
}));
const map: MapDefinition = {
  id: 'de_dust2',
  name: 'Dust2',
  enabled: true,
  order: 0,
  version: 1,
  width: 1024,
  height: 1024,
  floors: [{ id: 'main', name: 'main', radarUrl: '/dust.webp' }],
  bounds: { u: 0, v: 0, width: 1, height: 1 },
  calibration: { posX: -2476, posY: 3239, scale: 4.4, points: [] },
};
const overview: AdminOverview = {
  maps: [map],
  questions: [],
  capture: { points: 0, withImages: 0 },
  counts: [
    {
      mapId: map.id,
      calibrationValid: false,
      easy: 0,
      medium: 0,
      hard: 0,
      stale: 0,
    },
  ],
  daily: [],
};

beforeEach(() => {
  get.mockReset();
  post.mockReset();
  put.mockReset();
  get.mockImplementation(async (url: string) => ({
    data: url.endsWith('/overview')
      ? overview
      : url.endsWith('/checks')
        ? {
            missingAssets: [],
            compositions: { easy: false, normal: false, hard: false },
            dailyAvailable: false,
          }
        : { items: [], total: 0, pending: 0, pointCounts: {} },
  }));
});

describe('location administration workspace', () => {
  it('restores both levels after remount and mounts the restored location workspace', async () => {
    const first = renderAtRoute(<Admin />);
    fireEvent.click(screen.getByRole('button', { name: '图寻管理' }));
    await screen.findByRole('heading', { name: '批量标点与配图' });
    fireEvent.click(screen.getByRole('button', { name: '题目管理' }));
    await screen.findByText(/当前没有符合条件的题目/);
    first.unmount();

    renderAtRoute(<Admin />);
    await waitFor(() => expect(screen.getByText(/当前没有符合条件的题目/)).toBeVisible());
    expect(screen.getByRole('button', { name: '题目管理' })).toHaveAttribute('aria-current', 'page');
    expect(screen.queryByText('Players placeholder')).not.toBeInTheDocument();
  });

  it('ignores invalid saved navigation and isolates navigation by account', async () => {
    const key = `admin-tab:${useAuth.getState().user?.id ?? 'local'}:main`;
    sessionStorage.setItem(key, 'removed-tab');
    sessionStorage.setItem('admin-tab:another-account:main', 'location');
    const first = renderAtRoute(<Admin />);
    expect(screen.getByText('Players placeholder')).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '图寻管理' }));
    await screen.findByRole('heading', { name: '批量标点与配图' });
    expect(sessionStorage.getItem(key)).toBe('location');
    first.unmount();
    sessionStorage.removeItem(key);
    renderAtRoute(<Admin />);
    expect(screen.getByText('Players placeholder')).toBeVisible();
  });

  it('still permits navigation when browser session storage is unavailable', async () => {
    vi.spyOn(sessionStorage, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(sessionStorage, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    renderAtRoute(<Admin />);
    fireEvent.click(screen.getByRole('button', { name: '图寻管理' }));
    expect(await screen.findByRole('heading', { name: '批量标点与配图' })).toBeVisible();
  });

  it('preserves queued image Files across top-level admin tabs and pauses hidden workspace reads', async () => {
    URL.createObjectURL = vi.fn(() => 'blob:queued'); URL.revokeObjectURL = vi.fn();
    const { container } = renderAtRoute(<Admin />);
    fireEvent.click(screen.getByRole('button', { name: '图寻管理' }));
    await screen.findByRole('heading', { name: '批量标点与配图' });
    fireEvent.change(screen.getByLabelText('采集批次名称'), { target: { value: '保留此批次' } });
    const input = container.querySelector('input[type="file"][multiple]')!;
    expect(input).toBeTruthy();
    fireEvent.change(input, { target: { files: [new File(['pending'], 'pending.png', { type: 'image/png' })] } });
    await screen.findByText('pending.png');
    const before = get.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: '选手管理' }));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(get.mock.calls).toHaveLength(before);
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '图寻管理' }));
    expect(screen.getByLabelText('采集批次名称')).toHaveValue('保留此批次');
    expect(screen.getByText('pending.png')).toBeVisible();
  });

  it('opens a new independent image question from an existing point without copying its question identity', async () => {
    HTMLDialogElement.prototype.showModal = function () { this.setAttribute('open', ''); };
    HTMLDialogElement.prototype.close = function () { this.removeAttribute('open'); };
    File.prototype.arrayBuffer = async () => new ArrayBuffer(4);
    const original: Question = {
      id: 'existing-photo', version: 3, mapVersion: 1, mapId: map.id,
      floorId: 'main', u: .5, v: .5, capturePointId: 'same-point', tier: 'easy',
      status: 'draft', imageUrl: '/old.webp', thumbnailUrl: '/old-thumb.webp', imageHash: 'old-hash',
      world: { x: -223.2, y: 986.2, z: 64 },
      view: { pitch: 0, yaw: 90, roll: 0, fov: 90 },
      capturedAt: '2026-10-18T00:00:00Z', build: 'BUILD', source: 'TEST ONLY',
    };
    get.mockImplementation(async (url: string) => ({ data: url.endsWith('/overview')
      ? { ...overview, questions: [] } : url.endsWith('/questions') ? { items: [original], total: 1, pending: 1, pointCounts: {} } : { items: [] } }));
    post.mockImplementation(async (url: string) => ({ data: url.endsWith('/assets')
      ? { url: '/new.webp', thumbnailUrl: '/new-thumb.webp', hash: 'new-hash' }
      : { ...original, id: 'new-photo' } }));
    renderWithProviders(<AdminLocation />);
    await screen.findByRole('heading', { name: '批量标点与配图' });
    fireEvent.click(screen.getByRole('button', { name: '题目管理' }));
    fireEvent.click(await screen.findByRole('button', { name: '同点位新增图片题' }));
    expect(screen.getByLabelText('世界坐标 X')).toHaveValue(-223.2);
    expect(screen.getByLabelText('世界坐标 X')).toHaveAttribute('readonly');
    expect(screen.getByLabelText(/拍摄点编号/)).toHaveValue('same-point');
    expect(screen.getByRole('button', { name: '保存草稿' })).toBeDisabled();
    fireEvent.change(screen.getByLabelText('上传图片'), { target: { files: [new File(['new'], 'other-angle.png', { type: 'image/png' })] } });
    await screen.findByText(/图片已上传/);
    fireEvent.click(screen.getByLabelText('困难'));
    fireEvent.change(screen.getByLabelText('CS2 原始坐标指令'), { target: { value: 'setpos -223.2 986.2 64;setang 5 270 0' } });
    fireEvent.click(screen.getByRole('button', { name: '保存草稿' }));
    await waitFor(() => expect(post).toHaveBeenCalledWith('/admin/location/questions', expect.objectContaining({
      capturePointId: 'same-point', tier: 'hard', imageUrl: '/new.webp',
      world: original.world, view: { pitch: 5, yaw: 270, roll: 0, fov: 90 },
    })));
    const input = post.mock.calls.find(([url]) => url === '/admin/location/questions')![1];
    expect(input).not.toHaveProperty('id'); expect(input).not.toHaveProperty('version');
  });
  it('starts with capture and loads image checks only when requested', async () => {
    renderWithProviders(<AdminLocation />);
    expect(
      await screen.findByRole('heading', { name: '批量标点与配图' })
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '采集工作台' })).toHaveAttribute(
      'aria-current',
      'page'
    );
    expect(get).not.toHaveBeenCalledWith('/admin/location/checks');
    fireEvent.click(screen.getByRole('button', { name: '题库检查' }));
    await waitFor(() =>
      expect(get).toHaveBeenCalledWith('/admin/location/checks')
    );
    expect(await screen.findByText('缺失图片: 0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '题目管理' }));
    expect(await screen.findByText(/当前没有符合条件的题目/)).toBeInTheDocument();
  });

  it('keeps capture work mounted across tabs and offers structured map controls', async () => {
    const { container } = renderWithProviders(<AdminLocation />);
    await screen.findByRole('heading', { name: '批量标点与配图' });
    fireEvent.change(screen.getByLabelText('采集批次名称'), {
      target: { value: '我的采集' },
    });
    fireEvent.click(screen.getByRole('button', { name: '地图管理' }));
    expect(screen.queryByLabelText('雷达原点 X')).not.toBeInTheDocument();
    expect(screen.getByText('自动计算的原点与比例（只读）')).toBeInTheDocument();
    expect(screen.getAllByText('等待基准点：至少需要三个分散、不共线的点。').length).toBeGreaterThan(0);
    expect(
      container.querySelector('.location-batch-capture')
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '采集工作台' }));
    expect(screen.getByLabelText('采集批次名称')).toHaveValue('我的采集');
  });
});
