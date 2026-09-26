import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Route } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderAtRoute } from '../render';
import TurtleSoupGame from '../../src/pages/TurtleSoupGame';
import { useAuth } from '../../src/store/auth';
import type { SoupGame } from '../../src/turtleSoup';
import i18n from '../../src/i18n';

const { get, post } = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn() }));
vi.mock('../../src/api/client', () => ({ api: { get, post }, errMsg: () => 'request failed' }));
vi.mock('../../src/api/session', () => ({ ensureGuestSession: vi.fn(async () => {}) }));
vi.mock('../../src/api/playerList', () => ({
  getPlayerList: vi.fn(async () => [{ id: 1, nickname: 'Guess' }]),
  subscribePlayerList: vi.fn(() => () => {}),
  searchPlayerList: (list: unknown[]) => list,
}));
const key = 'csgofriberg_soup_session_guest_beginner';
const base: SoupGame = { gameId: 'soup1', mode: 'beginner', variant: 'turtle-soup', version: 0,
  status: 'playing', maxQuestions: 24, remainingQuestions: 24, questionCount: 0, guessCount: 0, guessUnlocked: true, events: [] };
const answer = { id: 2, nickname: 'Snapshot Answer', team: 'Team', nationality: 'CN', region: 'Asia', age: 25, role: 'Rifler', isActive: true, majorChampionships: 1, majorAppearances: 5 };
const options = { teams: ['Team', 'Team Two', 'Other', ''], countries: [
  { nationality: '中国', region: '亚洲' }, { nationality: '丹麦', region: '欧洲' },
] };
let state: SoupGame;
function renderGame(mode = 'beginner') {
  return renderAtRoute(<TurtleSoupGame />, { route: `/turtle-soup/${mode}`, path: '/turtle-soup/:mode',
    extraRoutes: <><Route path="/turtle-soup" element={<p>lobby</p>} /><Route path="/" element={<p>home</p>} /></> });
}
async function ready() { await waitFor(() => expect(screen.getByLabelText('年龄')).toBeEnabled()); }
async function ask() {
  fireEvent.change(screen.getByLabelText('年龄'), { target: { value: '25' } });
  fireEvent.submit(screen.getByLabelText('年龄').closest('form')!);
}
async function guess() {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('输入选手昵称...'), 'Guess');
  await user.keyboard('{Enter}');
}

describe('Turtle Soup interactions', () => {
  beforeEach(() => {
    get.mockReset(); post.mockReset(); state = { ...base };
    useAuth.setState({ user: null, initialized: true });
    get.mockImplementation(async (url: string) => ({ data: url.endsWith('question-options') ? options : state }));
    post.mockImplementation(async () => ({ data: state }));
  });

  it('rejects invalid routes before starting a game', async () => {
    renderGame('hard');
    expect(await screen.findByText('lobby')).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
  });

  it('shows matching team suggestions and submits the selected option directly', async () => {
    renderGame(); await ready();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText('输入战队关键字') as HTMLInputElement;
    const button = within(input.closest('form')!).getByRole('button', { name: '提问 · 战队' });
    await user.click(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.type(input, '   ');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.clear(input);
    await user.type(input, 'tea');
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(2);
    expect(screen.queryByRole('option', { name: 'Other' })).not.toBeInTheDocument();
    expect(button).toBeDisabled();
    await user.keyboard('{ArrowDown}{Enter}');
    expect(input).toHaveValue('Team Two');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await ready();
    expect(post).toHaveBeenLastCalledWith('/game/soup1/question', {
      field: 'team', value: 'Team Two', version: 0, requestId: expect.any(String),
    });
    await user.click(screen.getByLabelText('年龄'));
    await user.click(input);
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    expect(post.mock.calls.filter(([url]) => url.endsWith('/question'))).toHaveLength(1);
    await user.clear(input);
    expect(button).toBeDisabled();
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '无战队' }));
    expect(input).toHaveValue('无战队');
    await user.click(button);
    await ready();
    expect(post.mock.calls.at(-1)![1].value).toBe('');
  });

  it.each([['zh', '中'], ['zh', 'zhongguo'], ['zh', 'zg'], ['en', 'Chi'], ['ja', '中']])('searches translated countries and submits the snapshot value (%s: %s)', async (language, query) => {
    await i18n.changeLanguage(language);
    renderGame();
    const input = await screen.findByPlaceholderText(i18n.t('soup.searchCountry'));
    await waitFor(() => expect(input).toBeEnabled());
    const user = userEvent.setup();
    const form = input.closest('form')!;
    const button = within(form).getByRole('button');
    await user.click(input);
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.type(input, query);
    expect(within(screen.getByRole('listbox')).getAllByRole('option')).toHaveLength(1);
    await user.click(within(screen.getByRole('listbox')).getByRole('option'));
    await waitFor(() => expect(input).toBeEnabled());
    expect(post).toHaveBeenLastCalledWith('/game/soup1/question', {
      field: 'nationality', value: '中国', version: 0, requestId: expect.any(String),
    });
    await user.clear(input);
    await user.type(input, 'invalid-country');
    expect(button).toBeDisabled();
    fireEvent.submit(form);
    expect(post.mock.calls.filter(([url]) => url.endsWith('/question'))).toHaveLength(1);
    expect(document.getElementById('soup-role')?.tagName).toBe('SELECT');
    expect(document.getElementById('soup-isActive')?.tagName).toBe('SELECT');
  });

  it('protects composition and submits an intentional Tab selection', async () => {
    renderGame(); await ready();
    const user = userEvent.setup();
    const input = screen.getByPlaceholderText('输入国家／地区关键字');
    await user.click(input);
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: '中' } });
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(post).toHaveBeenCalledTimes(1);
    fireEvent.compositionEnd(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await user.keyboard('{ArrowDown}{Tab}');
    expect(input).toHaveValue('中国');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    await waitFor(() => expect(post).toHaveBeenCalledTimes(2));
    await user.click(screen.getByLabelText('年龄'));
    await user.click(input);
    expect(screen.getByRole('listbox')).toBeInTheDocument();
    await user.click(screen.getByLabelText('年龄'));
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
  });

  it('allows guessing immediately and consecutively while spending the shared budget', async () => {
    renderGame(); await ready();
    expect(screen.getByPlaceholderText('输入选手昵称...')).toBeEnabled();
    state = { ...base, version: 1, remainingQuestions: 23, questionCount: 1, guessUnlocked: true,
      events: [{ type: 'question', field: 'age', value: 25, level: 'close', requestId: 'q', elapsedMs: 1 }] };
    await ask();
    await waitFor(() => expect(screen.getByPlaceholderText('输入选手昵称...')).toBeEnabled());
    expect(screen.getByText('接近')).toBeInTheDocument();
    expect(post).toHaveBeenLastCalledWith('/game/soup1/question', { field: 'age', value: 25, version: 0, requestId: expect.any(String) });
    state = { ...state, version: 2, guessCount: 1, remainingQuestions: 22, guessUnlocked: true };
    await guess();
    await ready();
    expect(screen.getByPlaceholderText('输入选手昵称...')).toBeEnabled();
    expect(post).toHaveBeenLastCalledWith('/game/soup1/guess', { playerId: 1, version: 1, requestId: expect.any(String) });
    expect(document.querySelector('.soup-counter')).toHaveTextContent('22 / 24');
    state = { ...state, version: 3, guessCount: 2, remainingQuestions: 21 };
    await guess(); await ready();
    expect(post).toHaveBeenLastCalledWith('/game/soup1/guess', { playerId: 1, version: 2, requestId: expect.any(String) });
    expect(document.querySelector('.soup-counter')).toHaveTextContent('21 / 24');
  });

  it('prepends new feedback with its original number and scrolls only the history window', async () => {
    const savedEvents: SoupGame['events'] = [
      { type: 'question', field: 'age', value: 25, level: 'close', requestId: 'q1', elapsedMs: 1 },
      { type: 'guess', playerId: 1, nickname: 'Earlier Guess', correct: false, requestId: 'g1', elapsedMs: 2 },
    ];
    state = { ...base, version: 2, questionCount: 1, remainingQuestions: 22, guessCount: 1, events: savedEvents };
    renderGame(); await ready();
    const history = screen.getByRole('region', { name: '推理记录' });
    let items = within(history).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('Earlier Guess');
    expect(items[0].querySelector('.soup-event-number')).toHaveTextContent('02');
    expect(items[1]).toHaveTextContent('25');
    history.scrollTop = 200;
    const scrollPage = vi.spyOn(Element.prototype, 'scrollIntoView');
    scrollPage.mockClear();
    fireEvent.change(screen.getByLabelText('年龄'), { target: { value: '26' } });
    expect(history.scrollTop).toBe(200);
    state = { ...state, version: 3, questionCount: 2, remainingQuestions: 21, guessUnlocked: true,
      events: [...savedEvents, { type: 'question', field: 'age', value: 26, level: 'correct', requestId: 'q2', elapsedMs: 3 }] };
    fireEvent.submit(screen.getByLabelText('年龄').closest('form')!);
    await waitFor(() => expect(within(history).getAllByRole('listitem')).toHaveLength(3));
    items = within(history).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('26');
    expect(items[0]).toHaveTextContent('准确');
    expect(items[0].querySelector('.soup-event-number')).toHaveTextContent('03');
    expect(items[2].querySelector('.soup-event-number')).toHaveTextContent('01');
    expect(history.scrollTop).toBe(0);
    expect(scrollPage).not.toHaveBeenCalled();
    expect(savedEvents.map((event) => event.requestId)).toEqual(['q1', 'g1']);
    scrollPage.mockRestore();
  });

  it('allows a guess with one attempt left, then shows the losing receipt', async () => {
    state = { ...base, version: 23, questionCount: 23, remainingQuestions: 1, guessUnlocked: true };
    renderGame();
    await waitFor(() => expect(screen.getByPlaceholderText('输入选手昵称...')).toBeEnabled());
    expect(screen.getByLabelText('年龄')).toBeEnabled();
    expect(screen.getByText('提问和猜选手共用 24 次机会，可连续猜选手。')).toBeInTheDocument();
    state = { ...state, version: 24, status: 'lost', answer, guessCount: 1, remainingQuestions: 0, guessUnlocked: false };
    await guess();
    expect(await screen.findByRole('heading', { name: '本局结束' })).toBeInTheDocument();
    expect(screen.getByText('使用 23 次提问 · 1 次猜名')).toBeInTheDocument();
  });

  it.each([new Error('offline'), { isAxiosError: true, response: { status: 503 } }])('persists the exact operation for retry and suppresses double submits (%j)', async (failure) => {
    renderGame(); await ready();
    let reject!: (err: unknown) => void;
    post.mockReturnValueOnce(new Promise((_, fail) => { reject = fail; }));
    await ask(); await ask();
    const operation = post.mock.calls.at(-1)!;
    expect(post.mock.calls.filter(([url]) => url.endsWith('/question'))).toHaveLength(1);
    await act(async () => reject(failure));
    expect(await screen.findByText('上次操作尚未确认，请重试以同步结果。')).toBeInTheDocument();
    expect(screen.getByLabelText('年龄')).toBeDisabled();
    expect(JSON.parse(sessionStorage.getItem(key)!).pending.body).toEqual(operation[1]);
    state = { ...base, version: 1, remainingQuestions: 23, questionCount: 1, guessUnlocked: true };
    await userEvent.click(screen.getByRole('button', { name: '重试上次操作' }));
    await ready();
    expect(post.mock.calls.at(-1)).toEqual(operation);
    expect(JSON.parse(sessionStorage.getItem(key)!).pending).toBeUndefined();
  });

  it('restores a lost terminal response before replaying any pending write or starting', async () => {
    sessionStorage.setItem(key, JSON.stringify({ gameId: base.gameId, pending: { gameId: base.gameId, action: 'giveup', body: { requestId: 'done', version: 0 } } }));
    state = { ...base, status: 'lost', version: 1, answer, events: [{ type: 'giveup', requestId: 'done', elapsedMs: 10 }] };
    renderGame();
    expect(await screen.findByRole('heading', { name: '本局结束' })).toBeInTheDocument();
    expect(post).not.toHaveBeenCalled();
    expect(get).toHaveBeenCalledTimes(1); // No options endpoint for a terminal receipt.
  });

  it('restores an unaccepted pending request after refresh with the original payload', async () => {
    const operation = { gameId: base.gameId, action: 'question', body: { field: 'isActive', value: false, requestId: 'saved', version: 0 } };
    sessionStorage.setItem(key, JSON.stringify({ gameId: base.gameId, pending: operation }));
    renderGame(); await ready();
    expect(get.mock.invocationCallOrder[0]).toBeLessThan(post.mock.invocationCallOrder[0]);
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/game/soup1/question', operation.body);
  });

  it('discards stale writes and loads the newer version without re-executing', async () => {
    renderGame(); await ready();
    post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 409, data: { code: 'SOUP_STALE_STATE' } } });
    state = { ...base, version: 4, questionCount: 3, remainingQuestions: 21 };
    await ask();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('request failed'));
    expect(JSON.parse(sessionStorage.getItem(key)!).pending).toBeUndefined();
    await userEvent.click(screen.getByRole('button', { name: '重试' })); await ready();
    expect(post.mock.calls.filter(([url]) => url.endsWith('/question'))).toHaveLength(1);
    await ask();
    await waitFor(() => expect(post.mock.calls.at(-1)![1].version).toBe(4));
  });

  it('shows expiry without silently starting a new game', async () => {
    sessionStorage.setItem(key, JSON.stringify({ gameId: base.gameId }));
    get.mockRejectedValueOnce({ isAxiosError: true, response: { status: 404 } });
    renderGame();
    expect(await screen.findByRole('alert')).toHaveTextContent('本局已过期');
    expect(post).not.toHaveBeenCalled();
    await userEvent.click(within(screen.getByRole('alert')).getByRole('button'));
    await ready();
    expect(post).toHaveBeenCalledTimes(1);
    expect(post).toHaveBeenCalledWith('/game/start', { mode: 'beginner', variant: 'turtle-soup' });
  });

  it('reloads missing question options without creating another game', async () => {
    get.mockRejectedValueOnce(new Error('offline'));
    renderGame();
    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '重试' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '重试' })); await ready();
    expect(post).toHaveBeenCalledTimes(1);
    expect(get).toHaveBeenLastCalledWith('/game/soup1/question-options');
  });

  it('does not retry a definitively rejected write after refresh', async () => {
    const operation = { gameId: base.gameId, action: 'question', body: { field: 'age', value: 25, requestId: 'denied', version: 0 } };
    sessionStorage.setItem(key, JSON.stringify({ gameId: base.gameId, pending: operation }));
    post.mockRejectedValueOnce({ isAxiosError: true, response: { status: 403 } });
    renderGame();
    await screen.findByText('request failed');
    await userEvent.click(screen.getByRole('button', { name: '重试' })); await ready();
    expect(post).toHaveBeenCalledTimes(1);
    expect(JSON.parse(sessionStorage.getItem(key)!).pending).toBeUndefined();
  });

  it('keeps the active game local without focus or storage polling', async () => {
    renderGame(); await ready();
    const reads = get.mock.calls.length;
    state = { ...base, version: 3, questionCount: 2, remainingQuestions: 22, guessUnlocked: true };
    act(() => window.dispatchEvent(new StorageEvent('storage', { key: 'csgofriberg_soup_update', newValue: 'updated' })));
    act(() => window.dispatchEvent(new Event('focus')));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(get.mock.calls.length).toBe(reads);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('finds country options by their region pinyin initials', async () => {
    renderGame(); await ready();
    const user = userEvent.setup();
    await user.type(screen.getByPlaceholderText('输入国家／地区关键字'), 'oz');
    expect(within(screen.getByRole('listbox')).getByRole('option')).toHaveTextContent('丹麦');
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('gives up at zero questions only after confirmation, and shows unrecorded results', async () => {
    renderGame(); await ready();
    await userEvent.click(screen.getByRole('button', { name: '查看答案' }));
    expect(post).toHaveBeenCalledTimes(1);
    state = { ...base, status: 'lost', version: 1, answer, recorded: false };
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '查看答案' }));
    expect(await screen.findByText('使用 0 次提问 · 0 次猜名')).toBeInTheDocument();
    expect(screen.getByText(/未计入战绩/)).toBeInTheDocument();
  });

  it('exits before restarting and never sends giveup', async () => {
    renderGame(); await ready();
    await userEvent.click(screen.getByRole('button', { name: '重新开始' }));
    await userEvent.click(within(screen.getByRole('alertdialog')).getByRole('button', { name: '重新开始' }));
    await ready();
    expect(post.mock.calls.map(([url]) => url)).toEqual(['/game/start', '/game/soup1/exit', '/game/start']);
  });

  it('clears pending writes on account change and ignores their late response', async () => {
    renderGame(); await ready();
    let resolve!: (data: unknown) => void;
    post.mockReturnValueOnce(new Promise((done) => { resolve = done; }));
    await ask();
    act(() => useAuth.getState().setUser({ id: 42, username: 'test', role: 'user' }));
    await act(async () => resolve({ data: { ...base, status: 'won', answer } }));
    expect(sessionStorage.getItem(key)).toBeNull();
    expect(screen.queryByText('推理成功')).not.toBeInTheDocument();
  });
});
