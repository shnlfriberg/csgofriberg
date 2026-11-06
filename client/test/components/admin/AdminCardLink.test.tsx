import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { api } from '../../../src/api/client';
import i18n from '../../../src/i18n';
import { renderWithProviders } from '../../render';
import AdminCardLink from '../../../src/components/admin/AdminCardLink';

vi.mock('../../../src/api/client', () => ({ api: { get: vi.fn(), post: vi.fn() }, errMsg: () => 'request failed' }));
const current = 'a'.repeat(64), old = 'b'.repeat(64), candidate = 'c'.repeat(64);
beforeEach(async () => {
  vi.clearAllMocks(); await i18n.changeLanguage('zh');
  vi.mocked(api.get).mockImplementation(async path => ({ data: path.endsWith('/graphs') ? {
    catalog: { enabled: true, revision: 4, graph_version: current, ranked_enabled: 0 },
    graphs: [
      { version: current, source_revision: 4, source_hash: 'hash', published_at: 1 },
      { version: old, source_revision: 3, published_at: 1 },
      { version: candidate, source_revision: 4, source_hash: 'hash', published_at: null },
    ], outbox: [], events: [], monitoring: { scope: 'current-process' },
  } : [] }) as never);
  vi.mocked(api.post).mockResolvedValue({ data: { ok: true } } as never);
});
it('shows database numeric flags and submits only the selected scene', async () => {
  renderWithProviders(<AdminCardLink tab="graphs" />);
  const ranked = await screen.findByRole('checkbox', { name: '天梯匹配' });
  expect(ranked).not.toBeChecked();
  fireEvent.click(ranked);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/card-link/enabled', { scenes: { ranked: true } }));
});
it('requires a rollback reason, sends the current pointer, and never offers unpublished candidates for rollback', async () => {
  renderWithProviders(<AdminCardLink tab="graphs" />);
  const rollback = await screen.findByRole('button', { name: '回退到此版本' });
  expect(rollback).toBeDisabled();
  expect(screen.getAllByRole('button', { name: '回退到此版本' })).toHaveLength(1);
  expect(within(screen.getByText(old.slice(0,16)).closest('tr')!).getByRole('button', { name: '发布' })).toBeDisabled();
  fireEvent.change(screen.getByRole('textbox', { name: '回退原因' }), { target: { value: '  核验后回退  ' } });
  fireEvent.click(rollback);
  await waitFor(() => expect(api.post).toHaveBeenCalledWith('/admin/card-link/rollback', { version: old, expectedVersion: current, reason: '核验后回退' }));
  await waitFor(() => expect(screen.getByRole('textbox', { name: '回退原因' })).toHaveValue(''));
});
