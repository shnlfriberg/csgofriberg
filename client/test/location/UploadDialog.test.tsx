import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LocationQuestionDialog from '../../src/components/admin/LocationQuestionDialog';
import { parseCapturePosition } from '../../src/location/positionCode';
import { renderWithProviders } from '../render';
import type { CaptureDraft, MapDefinition } from '../../src/location/types';
const post = vi.hoisted(() => vi.fn());
vi.mock('../../src/location/api', () => ({
  api: { post },
  message: () => '上传失败',
}));
const map: MapDefinition = {
  id: 'de_dust2',
  name: 'Dust2',
  enabled: true,
  order: 0,
  version: 1,
  width: 1024,
  height: 1024,
  floors: [{ id: 'main', name: 'main', radarUrl: '/dust2.webp' }],
  bounds: { u: 0, v: 0, width: 1, height: 1 },
  calibration: { posX: -2476, posY: 3239, scale: 4.4, points: [] },
};
beforeEach(() => {
  post.mockReset();
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute('open');
  };
  File.prototype.arrayBuffer = async () => new ArrayBuffer(4);
});
describe('friendly question upload', () => {
  it('publishes a screenshot and radar answer without build, measured position or camera details', async () => {
    const draft: CaptureDraft = {
      id: 'radar-only', version: 1, mapVersion: 1, mapId: map.id, floorId: 'main',
      u: .4, v: .6, batchId: 'batch', batchName: '标点题', order: 1,
      capturePointId: 'radar-answer', createdAt: '2026-10-19T00:00:00Z',
      asset: { url: '/image.webp', thumbnailUrl: '/thumb.webp', hash: 'hash' },
    };
    const saved = vi.fn();
    post.mockResolvedValue({ data: { id: draft.id, status: 'published' } });
    renderWithProviders(<LocationQuestionDialog maps={[map]} question={null}
      captureDraft={draft} onClose={vi.fn()} onSaved={saved} />);
    expect(screen.getByRole('button', { name: '审核并发布' })).toBeDisabled();
    fireEvent.click(screen.getByLabelText('中'));
    expect(screen.getByRole('button', { name: '审核并发布' })).toBeEnabled();
    expect(screen.getByLabelText('世界坐标 X')).not.toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: '审核并发布' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    const payload = post.mock.calls[0][1].question;
    expect(payload).toMatchObject({ status: 'published', u: .4, v: .6, build: '' });
    expect(payload).not.toHaveProperty('world');
    expect(payload).not.toHaveProperty('view');
  });
  it('edits the chosen picture at a shared point, rejects different coordinates and saves its own tier and camera', async () => {
    const draft: CaptureDraft = {
      id: 'shared-point', version: 4, mapVersion: 1, mapId: map.id, floorId: 'main',
      u: .5, v: .5, batchId: 'batch', batchName: '多图', order: 1, capturePointId: 'same-answer',
      createdAt: new Date().toISOString(), world: { x: -223.2, y: 986.2, z: 64 },
      images: [1, 2].map(n => ({ id: `photo-${n}`, createdAt: new Date().toISOString(), asset: { url: `/image-${n}.webp`, thumbnailUrl: `/thumb-${n}.webp`, hash: `hash-${n}` } })),
    };
    const saved = vi.fn();
    post.mockResolvedValue({ data: { id: 'photo-2' } });
    const { container } = renderWithProviders(<LocationQuestionDialog maps={[map]} question={null}
      captureDraft={draft} captureImageId="photo-2" onClose={vi.fn()} onSaved={saved} />);
    fireEvent.click(screen.getByText('可选：坐标与视角辅助'));
    expect(screen.getByLabelText('世界坐标 X')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('世界坐标 X')).toHaveValue(-223.2);
    expect(screen.getByLabelText('所属地图')).toBeDisabled();
    fireEvent.change(screen.getByLabelText('CS2 原始坐标指令'), { target: { value: 'setpos 1000 986.2 64;setang 3 180 0' } });
    const submit = screen.getByRole('button', { name: '保存草稿' });
    fireEvent.submit(container.querySelector('form')!, { submitter: submit });
    expect(screen.getByRole('alert')).toHaveTextContent('同点位已有答案不一致');
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('CS2 原始坐标指令'), { target: { value: 'setpos -223.2 986.2 64;setang 3 180 0' } });
    fireEvent.change(screen.getByLabelText('游戏构建版本'), { target: { value: 'BUILD' } });
    fireEvent.click(screen.getByLabelText('困难'));
    fireEvent.click(screen.getByRole('button', { name: '审核并发布' }));
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith('/admin/location/capture-drafts/shared-point/complete', {
      version: 4, imageId: 'photo-2', question: expect.objectContaining({
        capturePointId: 'same-answer', world: draft.world, u: .5, v: .5,
        tier: 'hard', imageUrl: '/image-2.webp', status: 'published',
        view: { pitch: 3, yaw: 180, roll: 0, fov: 90 },
      }),
    });
  });
  it('finishes a capture draft using its image and location and explicitly chosen difficulty', async () => {
    const draft: CaptureDraft = {
      id: 'capture-1',
      version: 2,
      mapVersion: 1,
      mapId: map.id,
      floorId: 'main',
      u: 0.4,
      v: 0.6,
      batchId: 'batch-1',
      batchName: '采集批次',
      order: 1,
      capturePointId: 'tx-test-001',
      createdAt: '2026-10-17T00:00:00Z',
      asset: { url: '/image.webp', thumbnailUrl: '/thumb.webp', hash: 'hash' },
    };
    const saved = vi.fn();
    post.mockResolvedValue({ data: { id: draft.id } });
    const { container } = renderWithProviders(
      <LocationQuestionDialog
        maps={[map]}
        question={null}
        captureDraft={draft}
        onClose={vi.fn()}
        onSaved={saved}
      />
    );
    expect(screen.getByLabelText('所属地图')).toBeDisabled();
    expect(screen.getByLabelText(/拍摄点编号/)).toHaveValue('tx-test-001');
    expect(screen.getByLabelText('中')).not.toBeChecked();
    const button = screen.getByRole('button', { name: '保存草稿并完善下一题' });
    fireEvent.submit(container.querySelector('form')!, { submitter: button });
    expect(screen.getByRole('alert')).toHaveTextContent('请为此题选择难度');
    expect(post).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText('困难'));
    fireEvent.change(screen.getByLabelText('游戏构建版本'), {
      target: { value: 'BUILD' },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(saved).toHaveBeenCalledWith({ id: draft.id }, true)
    );
    expect(post).toHaveBeenCalledWith(
      '/admin/location/capture-drafts/capture-1/complete',
      {
        version: 2,
        imageId: 'capture-1',
        question: expect.objectContaining({
          capturePointId: draft.capturePointId,
          mapId: map.id,
          floorId: 'main',
          u: 0.4,
          v: 0.6,
          tier: 'hard',
          imageUrl: '/image.webp',
        }),
      }
    );
  });
  it('parses exact position/angle output without inventing missing values', () => {
    expect(
      parseCapturePosition('setpos_exact -223.2 986.2 64; setang 0 90 0')
    ).toEqual({
      x: '-223.2',
      y: '986.2',
      z: '64',
      pitch: '0',
      yaw: '90',
      roll: '0',
    });
    expect(parseCapturePosition('setpos 1 2 3')).toBeNull();
  });
  it('uploads, locates from measured coordinates and saves a draft using the form', async () => {
    const saved = vi.fn();
    post
      .mockResolvedValueOnce({
        data: {
          url: '/image.webp',
          thumbnailUrl: '/thumb.webp',
          hash: 'abc',
          width: 360,
          height: 360,
        },
      })
      .mockResolvedValueOnce({ data: { id: 'saved-question' } });
    const { container } = renderWithProviders(
      <LocationQuestionDialog
        maps={[map]}
        question={null}
        onClose={vi.fn()}
        onSaved={saved}
      />
    );
    const file = new File(['pixels'], 'capture.png', { type: 'image/png' });
    fireEvent.change(screen.getByLabelText('上传图片'), {
      target: { files: [file] },
    });
    expect(await screen.findByText(/图片已上传/)).toBeInTheDocument();
    expect(
      screen.getByText(/上传后仅保留原图正中心的 360×360 区域/)
    ).toBeInTheDocument();
    expect(
      screen.queryByText('正式截图请使用统一的 1920×1080 分辨率。')
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('可选：坐标与视角辅助'));
    fireEvent.change(screen.getByLabelText('游戏构建版本'), {
      target: { value: '25687242' },
    });
    fireEvent.change(screen.getByLabelText('CS2 原始坐标指令'), {
      target: { value: 'setpos -223.2 986.2 64; setang 0 90 0' },
    });
    fireEvent.click(screen.getByRole('button', { name: '解析并定位' }));
    expect(screen.getByText(/u 0.500000 · v 0.500000/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '审核并发布' })).toBeEnabled();
    const submit = screen.getByRole('button', { name: '保存草稿' });
    fireEvent.submit(container.querySelector('form')!, { submitter: submit });
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(post.mock.calls[1][0]).toBe('/admin/location/questions');
    expect(post.mock.calls[1][1]).toMatchObject({
      mapId: map.id,
      floorId: 'main',
      u: 0.5,
      v: 0.5,
      status: 'draft',
      build: '25687242',
      world: { x: -223.2, y: 986.2, z: 64 },
      view: { pitch: 0, yaw: 90, roll: 0, fov: 90 },
    });
  });
  it('rejects oversized images and clears coordinates when a different map is selected', async () => {
    renderWithProviders(
      <LocationQuestionDialog
        maps={[
          map,
          {
            ...map,
            id: 'de_nuke',
            name: 'Nuke',
            floors: [
              { id: 'upper', name: 'upper', radarUrl: '/nuke.webp' },
              { id: 'lower', name: 'lower', radarUrl: '/nuke-lower.webp' },
            ],
          },
        ]}
        question={null}
        onClose={vi.fn()}
        onSaved={vi.fn()}
      />
    );
    const file = new File(['pixels'], 'large.png', { type: 'image/png' });
    Object.defineProperty(file, 'size', { value: 17 * 1024 * 1024 });
    fireEvent.change(screen.getByLabelText('上传图片'), {
      target: { files: [file] },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('最大 16 MB');
    expect(post).not.toHaveBeenCalled();
    fireEvent.change(screen.getByLabelText('世界坐标 X'), {
      target: { value: '100' },
    });
    fireEvent.change(screen.getByLabelText('所属地图'), {
      target: { value: 'de_nuke' },
    });
    expect(screen.getByLabelText('世界坐标 X')).toHaveValue(null);
    expect(screen.getByLabelText('选择楼层')).toHaveValue('');
  });
  it('uses the original exact command to fill and submit world position and camera automatically', async () => {
    const draft: CaptureDraft = {
      id: 'raw-code-point',
      version: 1,
      mapVersion: 1,
      mapId: map.id,
      floorId: 'main',
      u: 0.5,
      v: 0.5,
      batchId: 'batch',
      batchName: 'Captured',
      order: 1,
      capturePointId: 'raw-point',
      createdAt: new Date().toISOString(),
      asset: { url: '/image.webp', thumbnailUrl: '/thumb.webp', hash: 'hash' },
    };
    post.mockResolvedValue({ data: { id: draft.id } });
    const saved = vi.fn();
    const { container } = renderWithProviders(
      <LocationQuestionDialog
        maps={[map]}
        question={null}
        captureDraft={draft}
        onClose={vi.fn()}
        onSaved={saved}
      />
    );
    fireEvent.change(screen.getByLabelText('CS2 原始坐标指令'), {
      target: {
        value:
          'setpos_exact -2093.968750 3117.968750 35.713593;setang_exact 7.128006 -19.183609 0.000000',
      },
    });
    expect(screen.getByLabelText('世界坐标 X')).toHaveValue(-2093.96875);
    expect(screen.getByLabelText('世界坐标 Y')).toHaveValue(3117.96875);
    expect(screen.getByLabelText('世界坐标 Z')).toHaveValue(35.713593);
    expect(screen.getByLabelText('俯仰角 Pitch')).toHaveValue(7.128006);
    expect(screen.getByLabelText('朝向 Yaw')).toHaveValue(-19.183609);
    expect(screen.getByLabelText('旋转角 Roll')).toHaveValue(0);
    fireEvent.click(screen.getByLabelText('中'));
    fireEvent.change(screen.getByLabelText('游戏构建版本'), {
      target: { value: 'TEST' },
    });
    fireEvent.submit(container.querySelector('form')!, {
      submitter: screen.getByRole('button', { name: '保存草稿' }),
    });
    await waitFor(() => expect(saved).toHaveBeenCalled());
    expect(post).toHaveBeenCalledWith(
      '/admin/location/capture-drafts/raw-code-point/complete',
      expect.objectContaining({
        question: expect.objectContaining({
          world: { x: -2093.96875, y: 3117.96875, z: 35.713593 },
          view: { pitch: 7.128006, yaw: -19.183609, roll: 0, fov: 90 },
        }),
      })
    );
  });
});
