import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../render';
import CardReplayDialog, { type CardReplay } from '../../src/card-link/ReplayDialog';

const replay: CardReplay = {
  match: { questions: [{ start: 3, end: 1 }, { start: 1, end: 3 }] },
  playersDirectory: [1, 2, 3].map(id => ({ id, nickname: `P${id}`, age: 25, nationality: 'Sweden', aliases: [], team: '' })),
  players: [{ id: 'a', name: 'Player A', retired: false, results: [{ path: [3, 2, 1], elapsed: 12500 }, null] },
    { id: 'b', name: 'Player B', retired: false, results: [null, null] }],
  evidence: [{ a: 2, b: 3, evidence: [{ team: 'Old Team', start: '2018-01-01', end: '2019-01-01', sources: [] },
    { team: 'Next Team', start: '2020-02-01', end: '2021-03-01', sources: [] }] },
    { a: 1, b: 2, evidence: [{ team: 'Other Link', start: '2016-01-01', end: '2017-01-01', sources: [] }] }],
};
beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
});
describe('visual card replay', () => {
  it('applies hearts and champion trim only to limited cards, including fixed endpoints', () => {
    const decorated: CardReplay = { ...replay,
      match: { ...replay.match!, variant: 'limited' },
      playersDirectory: replay.playersDirectory.map(p => ({ ...p,
        nationality: p.id === 3 ? '中国' : p.nationality, majorChampion: p.id === 1,
      })),
    };
    const { rerender } = renderWithProviders(<CardReplayDialog replay={decorated} close={vi.fn()} />);
    expect(within(screen.getByRole('article', { name: 'P3' })).getAllByText('♥')).toHaveLength(2);
    expect(screen.getByRole('article', { name: 'P1' }).querySelector('[data-cl-champion]')).not.toBeNull();
    expect(screen.getByRole('article', { name: 'P2' }).querySelector('[data-cl-champion]')).toBeNull();
    rerender(<CardReplayDialog replay={{ ...decorated, match: { ...decorated.match!, variant: 'unlimited' } }} close={vi.fn()} />);
    expect(screen.queryByText('♥')).toBeNull();
    expect(document.querySelector('[data-cl-champion]')).toBeNull();
  });
  it('renders frozen player cards in route order and places only the hovered edge evidence inside the modal', () => {
    const close = vi.fn(); renderWithProviders(<CardReplayDialog replay={replay} close={close} />);
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getAllByRole('article').map(card => card.getAttribute('aria-label'))).toEqual(['P3', 'P2', 'P1']);
    expect(within(dialog).getAllByText('年龄: 25')).toHaveLength(3);
    expect(dialog.querySelector('[draggable="true"]')).toBeNull();
    const connection = screen.getByRole('button', { name: /P3 ↔ P2/ });
    fireEvent.mouseEnter(connection);
    const tooltip = within(dialog).getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Old Team'); expect(tooltip).toHaveTextContent('Next Team');
    expect(tooltip).toHaveTextContent('2021-03-01'); expect(tooltip).not.toHaveTextContent('Other Link');
    expect(tooltip.parentElement).toBe(dialog);
    fireEvent.keyDown(connection, { key: 'Escape' });
    expect(screen.queryByRole('tooltip')).toBeNull(); expect(close).not.toHaveBeenCalled();
    fireEvent.focus(connection); expect(within(dialog).getByRole('tooltip')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('回合'), { target: { value: '1' } });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.queryByRole('button', { name: /↔/ })).toBeNull();
    expect(within(dialog).getAllByRole('article')).toHaveLength(2);
    expect(dialog).toHaveTextContent('未连通');
  });
  it('clears connection details when switching to another player', () => {
    renderWithProviders(<CardReplayDialog replay={replay} close={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /P3 ↔ P2/ }));
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('玩家'), { target: { value: '1' } });
    expect(screen.queryByRole('tooltip')).toBeNull();
    expect(screen.queryByRole('article', { name: 'P2' })).toBeNull();
  });
});
