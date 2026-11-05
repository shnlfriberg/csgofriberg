import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderWithProviders } from '../render';
import RoundResult from '../../src/card-link/RoundResult';
import type { View } from '../../src/card-link/types';

beforeEach(() => {
  HTMLDialogElement.prototype.showModal = vi.fn(function (this: HTMLDialogElement) { this.setAttribute('open', ''); });
  HTMLDialogElement.prototype.close = vi.fn(function (this: HTMLDialogElement) { this.removeAttribute('open'); });
});
const directory = [1, 2, 3].map(id => ({ id, nickname: `P${id}`, nationality: 'Sweden', age: 25, aliases: [], team: '' }));
const view = { id: 'result', status: 'finished', scene: 'daily', variant: 'limited', round: 0, rounds: 1, me: 'a',
  question: { start: 1, end: 3 }, current: { best: { path: [1, 2, 3], elapsed: 12345 } },
  players: [{ id: 'a', name: 'A', results: [{ path: [1, 2, 3], elapsed: 12345 }] }, { id: 'b', name: 'B', results: [null] }],
  solution: [1, 2, 3], evidence: [{ a: 1, b: 2, evidence: [{ team: 'Fixture team', start: '2020-01-01', end: '2021-01-01', sources: [] }] }],
} as unknown as View;
describe('card round result modal', () => {
  it('shows each example arrow’s frozen evidence inside the dialog, including for an unsolved player', () => {
    const exampleView = {...view, solution: [1, 3], evidence: [{a:3,b:1,evidence:[
      {team:'Example team',start:'2018-01-01',end:'2019-01-01',sources:[]},
      {team:'Returning team',start:'2022-01-01',end:'2023-01-01',sources:[]},
    ]}]};
    renderWithProviders(<RoundResult view={exampleView} directory={directory} close={vi.fn()} back={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('玩家'), {target:{value:'b'}});
    const summary = screen.getByText('示例最短路线', {selector:'summary'});
    summary.closest('details')!.open = true;
    const route = screen.getByLabelText('示例最短路线', {selector:'p'});
    const arrow = within(route).getByRole('button', {name:/P1 ↔ P3/});
    fireEvent.mouseEnter(arrow);
    const tooltip = within(screen.getByRole('dialog')).getByRole('tooltip');
    expect(tooltip).toHaveTextContent('Example team');
    expect(tooltip).toHaveTextContent('Returning team');
    expect(tooltip).toHaveTextContent('2018-01-01');
    expect(tooltip).toHaveTextContent('2023-01-01');
    fireEvent.keyDown(arrow, {key:'Escape'});
    expect(screen.queryByRole('tooltip')).toBeNull();
    fireEvent.focus(arrow);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
    fireEvent.keyDown(arrow, {key:'Escape'});
    fireEvent.click(arrow);
    expect(screen.getByRole('tooltip')).toBeInTheDocument();
  });
  it('shows the saved best cards and their evidence, allows closing and returning to the lobby', () => {
    const close = vi.fn(), back = vi.fn();
    renderWithProviders(<RoundResult view={view} directory={directory} close={close} back={back} />);
    const dialog = screen.getByRole('dialog', { name: '本轮结算' });
    expect(dialog).toHaveTextContent('12.345');
    expect(within(dialog).getAllByRole('article')).toHaveLength(3);
    fireEvent.click(within(within(dialog).getByRole('group', { name: '卡牌连接路线' })).getByRole('button', { name: /P1 ↔ P2/ }));
    expect(within(dialog).getByRole('tooltip')).toHaveTextContent('Fixture team');
    fireEvent.click(within(dialog).getByRole('button', { name: '查看牌桌' })); expect(close).toHaveBeenCalledOnce();
    fireEvent.click(within(dialog).getByRole('button', { name: '返回大厅' })); expect(back).toHaveBeenCalledOnce();
    fireEvent.change(screen.getByLabelText('玩家'), { target: { value: 'b' } });
    expect(dialog).toHaveTextContent('未连通'); expect(within(dialog).getAllByRole('article')).toHaveLength(2);
    expect(screen.queryByRole('tooltip')).toBeNull();
  });
  it('does not offer leaving during the multiplayer intermission and cleans up on next round', () => {
    const mounted = renderWithProviders(<RoundResult view={{ ...view, scene: 'friend', status: 'roundOver' }} directory={directory} close={vi.fn()} back={vi.fn()} />);
    expect(screen.getByText('下一回合将自动开始，无需关闭此窗口。')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '返回大厅' })).toBeNull();
    mounted.unmount(); expect(HTMLDialogElement.prototype.close).toHaveBeenCalled();
  });
});
