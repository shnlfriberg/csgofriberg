import { fireEvent, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import AdminResourceVersion from '../../src/components/admin/AdminResourceVersion';
import { renderAtRoute } from '../render';

describe('admin build details', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('loads server build information from health only when expanded', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: {
        version: '1.2.3', gitCommit: 'a'.repeat(40), builtAt: '2026-11-08T00:00:00Z',
        source: 'https://github.com/shnlfriberg/csgofriberg', releaseTag: 'v1.2.3', dirty: false,
      } }),
    });
    vi.stubGlobal('fetch', fetchMock);
    renderAtRoute(<AdminResourceVersion />);
    expect(fetchMock).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('应用构建信息'));
    expect(await screen.findByRole('link', { name: 'v1.2.3' })).toHaveAttribute('href', expect.stringContaining('/releases/tag/v1.2.3'));
    expect(fetchMock).toHaveBeenCalledWith('/api/health', { cache: 'no-store', credentials: 'same-origin' });
  });

  it('shows an unavailable state if the backend cannot provide build details', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    renderAtRoute(<AdminResourceVersion />);
    fireEvent.click(screen.getByText('应用构建信息'));
    expect(await screen.findByText(/暂时无法获取/)).toBeInTheDocument();
  });
});
