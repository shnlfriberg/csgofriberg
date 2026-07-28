import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../../api/client';
import i18n from '../../i18n';
import { renderWithProviders } from '../../test/render';
import AdminSpecialThanks from './AdminSpecialThanks';

vi.mock('../../api/client', () => ({
  api: {
    get: vi.fn(),
    post: vi.fn(),
    patch: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  },
  errMsg: vi.fn(() => 'request failed'),
}));

describe('AdminSpecialThanks', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await i18n.changeLanguage('zh');
  });

  it('adds and removes names from the thanks list', async () => {
    const user = userEvent.setup();
    vi.mocked(api.get)
      .mockResolvedValueOnce({ data: { items: [] } } as never)
      .mockResolvedValue({ data: { items: [{ id: 9, name: '社区玩家', note: '持续反馈游戏体验' }] } } as never);
    vi.mocked(api.post).mockResolvedValue({
      data: { id: 9, name: '社区玩家', note: '持续反馈游戏体验', created: true },
    } as never);
    vi.mocked(api.delete).mockResolvedValue({ data: { ok: true } } as never);

    renderWithProviders(<AdminSpecialThanks />);
    expect(await screen.findByText('暂无感谢名单')).toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('输入需要感谢的名字'), '社区玩家');
    await user.type(screen.getByPlaceholderText('填写感谢备注（可选）'), '持续反馈游戏体验');
    await user.click(screen.getByRole('button', { name: '添加到名单' }));
    expect(api.post).toHaveBeenCalledWith('/admin/special-thanks', {
      name: '社区玩家',
      note: '持续反馈游戏体验',
    });
    expect(await screen.findByText('社区玩家')).toBeInTheDocument();
    expect(screen.getByText('持续反馈游戏体验')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '移除 社区玩家' }));
    const dialog = await screen.findByRole('alertdialog', { name: '将 社区玩家 移出感谢名单？' });
    await user.click(within(dialog).getByRole('button', { name: '移除' }));
    expect(api.delete).toHaveBeenCalledWith('/admin/special-thanks/9');
  });

  it('edits entries and persists their complete order', async () => {
    const user = userEvent.setup();
    const items = [
      { id: 1, name: '数据整理', note: '校对选手资料' },
      { id: 2, name: '测试玩家', note: '反馈交互问题' },
    ];
    vi.mocked(api.get).mockResolvedValue({ data: { items } } as never);
    vi.mocked(api.patch).mockResolvedValue({ data: { ...items[0], note: '更新后的备注' } } as never);
    vi.mocked(api.put).mockResolvedValue({ data: { ok: true } } as never);

    renderWithProviders(<AdminSpecialThanks />);
    await user.click(await screen.findByRole('button', { name: '编辑 数据整理' }));
    expect(screen.getByPlaceholderText('输入需要感谢的名字')).toHaveValue('数据整理');
    const note = screen.getByPlaceholderText('填写感谢备注（可选）');
    await user.clear(note);
    await user.type(note, '更新后的备注');
    await user.click(screen.getByRole('button', { name: '保存修改' }));
    expect(api.patch).toHaveBeenCalledWith('/admin/special-thanks/1', {
      name: '数据整理',
      note: '更新后的备注',
    });

    await user.click(screen.getByRole('button', { name: '下移 数据整理' }));
    expect(api.put).toHaveBeenCalledWith('/admin/special-thanks/order', { ids: [2, 1] });
  });
});
