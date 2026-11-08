import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import VersionFooter, { BuildVersion } from '../../src/components/VersionFooter';
import type { BuildInfo } from '../../src/buildInfo';

const info: BuildInfo = {
  version: '1.2.3', gitCommit: 'abcdef0123456789abcdef0123456789abcdef01',
  builtAt: '2026-11-08T00:00:00.000Z', source: 'https://github.com/shnlfriberg/csgofriberg',
  releaseTag: 'v1.2.3', dirty: false,
};

describe('build version display', () => {
  it('links the release and seven-character hash to their exact sources', () => {
    render(<BuildVersion info={info} />);
    expect(screen.getByRole('link', { name: 'v1.2.3' })).toHaveAttribute('href', `${info.source}/releases/tag/v1.2.3`);
    expect(screen.getByRole('link', { name: 'abcdef0' })).toHaveAttribute('href', `${info.source}/commit/${info.gitCommit}`);
  });

  it('does not link development builds to nonexistent releases', () => {
    render(<BuildVersion info={{ ...info, version: '1.2.3-dev+gabcdef0.dirty', releaseTag: null }} />);
    expect(screen.getByText('Currently v1.2.3-dev+gabcdef0.dirty')).toBeInTheDocument();
    expect(screen.getAllByRole('link')).toHaveLength(1);
  });

  it('uses the requested copyright and current year without an alpha badge', () => {
    render(<VersionFooter />);
    expect(screen.getByRole('contentinfo')).toHaveTextContent(`© shnlfriberg ${new Date().getFullYear()}`);
    expect(screen.queryByText(/alpha|αlpha/i)).not.toBeInTheDocument();
  });
});
