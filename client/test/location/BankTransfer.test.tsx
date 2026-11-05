import { fireEvent, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import LocationBankTransfer from '../../src/components/admin/LocationBankTransfer';
import { renderWithProviders } from '../render';
const { post, get } = vi.hoisted(() => ({ post: vi.fn(), get: vi.fn() }));
vi.mock('../../src/location/api', () => ({
  api: { post, get },
  message: (error: any) => error.code || '请求失败',
}));
const preview = {
  token: 'test-token',
  fingerprint: 'test-fingerprint',
  expiresAt: Date.now() + 10000,
  exportedAt: '2026-10-05T00:00:00Z',
  questions: 5,
  assets: 10,
  mapChanges: 1,
  added: 5,
  updated: 0,
  skipped: 0,
  conflicts: [],
  canImport: true,
};
beforeEach(() => {
  post.mockReset();
  get.mockReset();
});
describe('bank transfer workflow', () => {
  it('uploads only for preview, then imports using the checked catalog fingerprint', async () => {
    const imported = vi.fn().mockResolvedValue(undefined);
    post
      .mockResolvedValueOnce({ data: preview })
      .mockResolvedValueOnce({
        data: { added: 5, updated: 0, skipped: 0, maps: 1 },
      });
    renderWithProviders(<LocationBankTransfer onImported={imported} />);
    fireEvent.change(
      screen.getByLabelText('导入题库 ZIP', { selector: 'input' }),
      {
        target: {
          files: [new File(['zip'], 'bank.zip', { type: 'application/zip' })],
        },
      }
    );
    expect(await screen.findByText('导入预览')).toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    expect(imported).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: '确认导入题库' }));
    await waitFor(() => expect(imported).toHaveBeenCalledTimes(1));
    expect(post.mock.calls[1]).toEqual([
      '/admin/location/bank/import',
      {
        token: preview.token,
        fingerprint: preview.fingerprint,
        updateQuestions: false,
      },
    ]);
    expect(screen.getByText(/导入完成：新增 5/)).toBeInTheDocument();
  });
  it('blocks conflicting imports until explicit update permission has been rechecked', async () => {
    post
      .mockResolvedValueOnce({
        data: {
          ...preview,
          canImport: false,
          added: 0,
          conflicts: [{ id: 'q-1', code: 'LOCATION_BANK_QUESTION_CONFLICT' }],
        },
      })
      .mockResolvedValueOnce({
        data: {
          ...preview,
          fingerprint: 'new-checked-fingerprint',
          added: 0,
          updated: 1,
        },
      })
      .mockResolvedValueOnce({
        data: { added: 0, updated: 1, skipped: 0, maps: 1 },
      });
    renderWithProviders(
      <LocationBankTransfer onImported={vi.fn().mockResolvedValue(undefined)} />
    );
    fireEvent.change(
      screen.getByLabelText('导入题库 ZIP', { selector: 'input' }),
      { target: { files: [new File(['zip'], 'bank.zip')] } }
    );
    await screen.findByText('导入预览');
    expect(screen.getByRole('button', { name: '确认导入题库' })).toBeDisabled();
    fireEvent.click(
      screen.getByRole('checkbox', { name: '允许更新同编号的题目及采集半成品' })
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '确认导入题库' })).toBeEnabled()
    );
    expect(post.mock.calls[1]).toEqual([
      '/admin/location/bank/recheck',
      { token: preview.token, updateQuestions: true },
    ]);
    fireEvent.click(screen.getByRole('button', { name: '确认导入题库' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(3));
    expect(post.mock.calls[2][1]).toMatchObject({
      updateQuestions: true,
      fingerprint: 'new-checked-fingerprint',
    });
  });
  it('rejects oversized files before upload and permits cancel without mutation', async () => {
    renderWithProviders(<LocationBankTransfer onImported={vi.fn()} />);
    const file = new File(['zip'], 'huge.zip');
    Object.defineProperty(file, 'size', { value: 1024 * 1024 * 1024 + 1 });
    fireEvent.change(
      screen.getByLabelText('导入题库 ZIP', { selector: 'input' }),
      { target: { files: [file] } }
    );
    expect(await screen.findByRole('alert')).toHaveTextContent('最大 1 GiB');
    expect(post).not.toHaveBeenCalled();
    post.mockResolvedValueOnce({ data: preview });
    fireEvent.change(
      screen.getByLabelText('导入题库 ZIP', { selector: 'input' }),
      { target: { files: [new File(['zip'], 'bank.zip')] } }
    );
    await screen.findByText('导入预览');
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(screen.queryByText('导入预览')).not.toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
  });
});
