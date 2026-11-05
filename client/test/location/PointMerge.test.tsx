import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../render';
import PointMergePanel from '../../src/components/admin/location/PointMergePanel';
import type { MapDefinition } from '../../src/location/types';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/location/api', () => ({ api: { get, post }, message: () => '请求失败' }));
const map: MapDefinition = { id: 'de_dust2', name: 'Dust2', version: 1, enabled: true, order: 0, width: 1024, height: 1024,
  bounds: { u: 0, v: 0, width: 1, height: 1 }, floors: [{ id: 'main', name: 'Main', radarUrl: '/test.webp' }],
  calibration: { posX: 0, posY: 1024, scale: 1, points: [] } };
const items = ['point-a', 'point-b', 'point-old'].map((capturePointId, i) => ({ capturePointId, mapId: map.id, floorId: 'main',
  u: .4 + i * .01, v: .5, fingerprint: String(i).repeat(64), questions: i + 1, images: 1, thumbnails: [], eligible: i < 2 }));
beforeEach(() => {
  get.mockReset(); post.mockReset();
  get.mockResolvedValue({ data: { mapVersion: 1, items } });
  post.mockResolvedValue({ data: { capturePointId: 'point-a', points: 2, questions: 3, images: 2 } });
});
async function select() {
  const checkboxes = await screen.findAllByRole('checkbox');
  fireEvent.click(checkboxes[0]); fireEvent.click(checkboxes[1]);
  fireEvent.click(screen.getByRole('button', { name: '选择合并位置' }));
}
describe('point merge workflow', () => {
  it('requires multiple points and a new target, includes all statuses, and refreshes after confirmation', async () => {
    const changed = vi.fn(async () => undefined);
    renderWithProviders(<PointMergePanel map={map} floorId="main" onChanged={changed} />);
    expect(screen.getByRole('button', { name: '选择合并位置' })).toBeDisabled();
    await select();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);
    expect(screen.getByRole('button', { name: '确认合并到此处' })).toBeDisabled();
    const radar = screen.getByRole('group', { name: '再找位置' });
    fireEvent.keyDown(radar, { key: 'ArrowUp' });
    fireEvent.click(screen.getByRole('button', { name: '确认合并到此处' }));
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(post).toHaveBeenCalledWith('/admin/location/points/merge', expect.objectContaining({
      mapId: map.id, floorId: 'main', u: .5, v: .5 - 1 / 1024, points: items.slice(0, 2).map(({ capturePointId, fingerprint }) => ({ capturePointId, fingerprint })),
    }));
    expect(await screen.findByText('已将 2 个点合并，更新 3 道题并保留 2 张待制作截图。')).toBeInTheDocument();
  });
  it('freezes uncertain requests and retries with the same operation ID, without duplicate concurrent requests', async () => {
    post.mockRejectedValueOnce(new Error('network'));
    renderWithProviders(<PointMergePanel map={map} floorId="main" onChanged={vi.fn(async () => undefined)} />);
    await select(); fireEvent.keyDown(screen.getByRole('group', { name: '再找位置' }), { key: 'ArrowUp' });
    const confirm = screen.getByRole('button', { name: '确认合并到此处' });
    fireEvent.click(confirm); fireEvent.click(confirm);
    await screen.findByRole('alert'); expect(post).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: '返回选择点位' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: '重试同一次合并' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    expect(post.mock.calls[1][1]).toEqual(post.mock.calls[0][1]);
  });
  it('lets users cancel target picking without writing and excludes obsolete map points', async () => {
    renderWithProviders(<PointMergePanel map={map} floorId="main" onChanged={vi.fn(async () => undefined)} />);
    await select(); fireEvent.click(screen.getByRole('button', { name: '返回选择点位' }));
    expect(screen.getAllByRole('checkbox')[0]).toBeChecked();
    expect(screen.getAllByRole('checkbox')[2]).toBeDisabled();
    expect(post).not.toHaveBeenCalled();
  });
});
