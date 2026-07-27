import { FormEvent, useCallback, useEffect, useId, useRef, useState } from 'react';
import { getPlayerList, searchPlayerList, subscribePlayerList } from '../api/playerList';
import { errMsg } from '../api/client';
import { toast } from './Toast';
import { useTranslation } from 'react-i18next';

interface Suggestion {
  id: number;
  nickname: string;
}

interface Props {
  onPick: (player: Suggestion) => boolean | void | Promise<boolean | void>;
  onFocusChange?: (focused: boolean) => void;
  statusText?: string;
  disabled?: boolean;
  placeholder?: string;
  buttonText?: string;
}

/**
 * 底部输入栏:选手昵称输入 + 提交按钮,自动补全列表从输入框上方弹出(原版布局)。
 * 回车提交当前高亮项,方向键或 Tab 循环切换。
 */
export default function GuessInputBar({
  onPick,
  onFocusChange,
  statusText,
  disabled,
  placeholder,
  buttonText,
}: Props) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [items, setItems] = useState<Suggestion[]>([]);
  const [active, setActive] = useState(0);
  const [open, setOpen] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const listId = useId();
  const textRef = useRef('');
  const tabCycling = useRef(false);
  const focused = useRef(false);
  const refocusAfterSubmit = useRef(false);
  const players = useRef<Suggestion[]>([]);
  const visiblePlaceholder = placeholder ?? t('guess.placeholder');
  const visibleButtonText = buttonText ?? t('guess.submit');

  const applyQuery = useCallback((
    query: string,
    list = players.current,
    resetActive = true
  ) => {
    if (resetActive) tabCycling.current = false;
    if (!query.trim()) {
      setItems([]);
      setOpen(false);
      return;
    }
    const next = searchPlayerList(list, query);
    setItems(next);
    setActive((current) => resetActive ? 0 : Math.min(current, Math.max(0, next.length - 1)));
    setOpen(focused.current && next.length > 0);
  }, []);

  const applyPlayerList = useCallback((list: Suggestion[]) => {
    players.current = list;
    applyQuery(textRef.current, list, false);
  }, [applyQuery]);

  useEffect(() => {
    const unsubscribe = subscribePlayerList(applyPlayerList);
    void getPlayerList().then(applyPlayerList).catch((error) => toast.error(errMsg(error)));
    return unsubscribe;
  }, [applyPlayerList]);

  useEffect(() => {
    if (!open) return;
    list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (submitting || disabled || !refocusAfterSubmit.current) return;
    refocusAfterSubmit.current = false;
    input.current?.focus();
  }, [disabled, submitting]);

  useEffect(() => {
    const focusInputOnEnter = (event: KeyboardEvent) => {
      if (
        event.key !== 'Enter' ||
        event.defaultPrevented ||
        event.isComposing ||
        submitting ||
        disabled ||
        document.querySelector('[aria-modal="true"]')
      ) return;

      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest('input, textarea, select, button, a, [contenteditable="true"], [role="button"]')
      ) return;

      event.preventDefault();
      input.current?.focus();
    };

    window.addEventListener('keydown', focusInputOnEnter);
    return () => window.removeEventListener('keydown', focusInputOnEnter);
  }, [disabled, submitting]);

  const pick = async (item: Suggestion) => {
    if (disabled || submitting) return;
    const submittedText = textRef.current;
    refocusAfterSubmit.current = true;
    setSubmitting(true);
    try {
      const accepted = await onPick(item);
      if (accepted === false || textRef.current !== submittedText) return;
      textRef.current = '';
      tabCycling.current = false;
      setText('');
      setItems([]);
      setOpen(false);
    } finally {
      setSubmitting(false);
    }
  };

  const submit = (e?: FormEvent) => {
    e?.preventDefault();
    if (items.length) void pick(items[active]);
  };

  return (
    <>
      {open && (
        <ul className="autocomplete-list" role="listbox" id={listId} ref={list} aria-label={visiblePlaceholder}>
          {items.map((item, i) => (
            <li
              key={item.id}
              id={`${listId}-opt-${i}`}
              role="option"
              aria-selected={i === active}
              className={i === active ? 'active' : ''}
              onMouseDown={(event) => {
                event.preventDefault();
                void pick(item);
              }}
            >
              {item.nickname}
            </li>
          ))}
        </ul>
      )}
      <form className="input-bar" onSubmit={submit}>
        <input
          ref={input}
          className="input"
          value={text}
          disabled={disabled}
          placeholder={visiblePlaceholder}
          autoComplete="off"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && items.length ? `${listId}-opt-${active}` : undefined}
          onChange={(e) => {
            const query = e.target.value;
            textRef.current = query;
            setText(query);
            applyQuery(query);
            if (players.current.length) void getPlayerList().catch(() => undefined);
          }}
          onFocus={() => {
            focused.current = true;
            if (items.length) setOpen(true);
            void getPlayerList().catch(() => undefined);
            onFocusChange?.(true);
          }}
          onBlur={() => {
            focused.current = false;
            tabCycling.current = false;
            onFocusChange?.(false);
            setTimeout(() => setOpen(false), 150);
          }}
          onKeyDown={(e) => {
            if (!items.length) return;
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              tabCycling.current = false;
              setActive((a) => (a + 1) % items.length);
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              tabCycling.current = false;
              setActive((a) => (a - 1 + items.length) % items.length);
            } else if (e.key === 'Escape') {
              if (open) {
                e.preventDefault();
                tabCycling.current = false;
                setOpen(false);
              }
            } else if (e.key === 'Tab' && open) {
              if (items.length === 1 && tabCycling.current && text === items[0].nickname) {
                tabCycling.current = false;
                setOpen(false);
                return;
              }
              e.preventDefault();
              const direction = e.shiftKey ? -1 : 1;
              const nextActive = tabCycling.current
                ? (active + direction + items.length) % items.length
                : e.shiftKey
                  ? (active - 1 + items.length) % items.length
                  : active;
              const completed = items[nextActive].nickname;
              tabCycling.current = true;
              setActive(nextActive);
              textRef.current = completed;
              setText(completed);
            }
          }}
        />
        <button
          className="btn"
          disabled={disabled || submitting || !items.length}
          onMouseDown={(event) => event.preventDefault()}
        >
          {submitting ? t('guess.submitting') : visibleButtonText}
        </button>
      </form>
      {statusText !== undefined && (
        <div className="guess-input-feedback" role="status" aria-live="polite">
          {statusText}
        </div>
      )}
    </>
  );
}
