import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import MapManager from '../../src/components/admin/location/MapManager';
import { renderWithProviders } from '../render';
import type { MapDefinition } from '../../src/location/types';
import { applyCalibration } from '../../../server/src/location/calibration';

const put = vi.hoisted(() => vi.fn());
vi.mock('../../src/location/api', () => ({
  api: { put },
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
const code =
  'setpos_exact -2093.968750 3117.968750 35.713593;setang_exact 7.128006 -19.183609 0.000000';
beforeEach(() => {
  put.mockReset();
  put.mockImplementation(async (_url, value) => ({ data: value }));
});

describe('calibration from raw CS2 commands', () => {
  it('previews and saves fitted parameters from existing references instead of presets', async () => {
    const measured = structuredClone(map);
    measured.calibration.points = [
      { u: .1, v: .1 }, { u: .9, v: .1 }, { u: .1, v: .9 },
    ].map(p => ({ ...p, x: -1000 + p.u * 1024 * 2,
      y: 2000 - p.v * 1024 * 2, floorId: 'main' }));
    const changed = vi.fn();
    renderWithProviders(<MapManager maps={[measured]} onChanged={changed} />);
    expect(screen.getByText('已自动计算，校准检查通过；保存后生效。')).toBeInTheDocument();
    expect(screen.getByText('拟合后最大偏差 0.000%（允许 ≤ 0.5%）。')).toBeInTheDocument();
    expect(screen.queryByLabelText('雷达原点 X')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    const saved = put.mock.calls[0][1] as MapDefinition;
    expect(saved.calibration.posX).toBeCloseTo(-1000, 8);
    expect(saved.calibration.posY).toBeCloseTo(2000, 8);
    expect(saved.calibration.scale).toBeCloseTo(2, 10);
    expect(saved.calibration.points).toEqual(measured.calibration.points);
    fireEvent.click(screen.getByRole('button', { name: '移除第 1 个校准点' }));
    expect(screen.queryByText('已自动计算，校准检查通过；保存后生效。')).not.toBeInTheDocument();
    expect(screen.getAllByText('等待基准点：至少需要三个分散、不共线的点。').length).toBeGreaterThan(0);
  });

  it('shows residuals for contradictory references after fitting', () => {
    const measured = structuredClone(map);
    measured.calibration.points = [
      { u: .1, v: .1 }, { u: .9, v: .1 }, { u: .1, v: .9 }, { u: .9, v: .9 },
    ].map(p => ({ ...p, x: -1000 + p.u * 1024 * 2,
      y: 2000 - p.v * 1024 * 2, floorId: 'main' }));
    measured.calibration.points[3].x += 1000;
    renderWithProviders(<MapManager maps={[measured]} onChanged={vi.fn()} />);
    expect(screen.getByText('已自动计算；请补齐各楼层基准点或复核拟合偏差较大的点。')).toBeInTheDocument();
    expect(applyCalibration(measured).calibration.scale).not.toBe(map.calibration.scale);
  });

  it('fills coordinates automatically and saves them with an independently selected radar point', async () => {
    const changed = vi.fn();
    renderWithProviders(<MapManager maps={[map]} onChanged={changed} />);
    fireEvent.change(screen.getByLabelText('CS2 原始坐标指令'), {
      target: { value: code },
    });
    expect(screen.getByLabelText('世界坐标 X')).toHaveValue(-2093.96875);
    expect(screen.getByLabelText('世界坐标 Y')).toHaveValue(3117.96875);
    expect(screen.getByRole('button', { name: '添加校准点' })).toBeDisabled();
    fireEvent.keyDown(screen.getByRole('group', { name: '再找位置' }), {
      key: 'ArrowRight',
    });
    fireEvent.click(screen.getByRole('button', { name: '添加校准点' }));
    expect(screen.getByLabelText('CS2 原始坐标指令')).toHaveValue('');
    fireEvent.click(screen.getByRole('button', { name: '保存' }));
    await waitFor(() => expect(changed).toHaveBeenCalled());
    expect(put).toHaveBeenCalledWith(
      '/admin/location/maps/de_dust2',
      expect.objectContaining({
        calibration: expect.objectContaining({
          points: [
            {
              x: -2093.96875,
              y: 3117.96875,
              u: 0.5 + 1 / 1024,
              v: 0.5,
              floorId: 'main',
            },
          ],
        }),
      })
    );
  });

  it('clears previous coordinates when a replacement command is invalid', () => {
    renderWithProviders(<MapManager maps={[map]} onChanged={vi.fn()} />);
    fireEvent.keyDown(screen.getByRole('group', { name: '再找位置' }), {
      key: 'ArrowRight',
    });
    const input = screen.getByLabelText('CS2 原始坐标指令');
    fireEvent.change(input, { target: { value: code } });
    expect(screen.getByRole('button', { name: '添加校准点' })).toBeEnabled();
    fireEvent.change(input, { target: { value: 'setpos_exact invalid' } });
    fireEvent.blur(input);
    expect(screen.getByLabelText('世界坐标 X')).toHaveValue(null);
    expect(screen.getByRole('button', { name: '添加校准点' })).toBeDisabled();
    expect(screen.getByRole('alert')).toHaveTextContent('setpos_exact');
    expect(put).not.toHaveBeenCalled();
  });
});
