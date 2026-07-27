import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { api } from '../api/client';
import { renderWithProviders } from '../test/render';
import AnnouncementDialog from './AnnouncementDialog';

vi.mock('../api/client', () => ({
  api: { get: vi.fn() },
}));

const get = vi.mocked(api.get);

describe('AnnouncementDialog', () => {
  beforeEach(() => {
    get.mockReset();
  });

  it('requires acknowledgement, persists it, and shows the next popup', async () => {
    const user = userEvent.setup();
    get.mockResolvedValue({
      data: [
        { id: 2, title: '第二条', content: '第二条内容', is_popup: true },
        { id: 1, title: '第一条', content: '第一条内容', is_popup: 1 },
        { id: 3, title: '普通公告', content: '不弹窗', is_popup: false },
      ],
    } as never);

    renderWithProviders(<AnnouncementDialog />);
    const dialog = await screen.findByRole('alertdialog');
    expect(dialog).toHaveTextContent('第二条');

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(screen.getByRole('alertdialog')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: '我已知晓' }));
    expect(await screen.findByText('第一条内容')).toBeInTheDocument();
    expect(localStorage.getItem('csgofriberg.acknowledged-popup-announcements')).toContain('2');

    await user.click(screen.getByRole('button', { name: '我已知晓' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  it('does not show an announcement that was already acknowledged', async () => {
    localStorage.setItem('csgofriberg.acknowledged-popup-announcements', '[7]');
    get.mockResolvedValue({
      data: [{ id: 7, title: '已确认', content: '不会再弹', is_popup: true }],
    } as never);

    renderWithProviders(<AnnouncementDialog />);
    await waitFor(() => expect(get).toHaveBeenCalledWith('/announcements'));
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });
});
