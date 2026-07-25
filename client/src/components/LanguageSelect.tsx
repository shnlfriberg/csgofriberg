import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, Languages } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { AppLanguage, supportedLanguages } from '../i18n';

const LABELS: Record<AppLanguage, string> = {
  zh: '中文',
  en: 'English',
  ja: '日本語',
};

const SHORT_LABELS: Record<AppLanguage, string> = {
  zh: 'ZH',
  en: 'EN',
  ja: 'JA',
};

export default function LanguageSelect() {
  const { i18n, t } = useTranslation();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const language = (supportedLanguages.find((item) => i18n.resolvedLanguage === item) ?? 'zh') as AppLanguage;

  useEffect(() => {
    if (!open) return;
    const selectedIndex = supportedLanguages.indexOf(language);
    requestAnimationFrame(() => optionRefs.current[selectedIndex]?.focus());

    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [language, open]);

  const chooseLanguage = (nextLanguage: AppLanguage) => {
    void i18n.changeLanguage(nextLanguage);
    setOpen(false);
    requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const moveFocus = (currentIndex: number, direction: 1 | -1) => {
    const nextIndex = (currentIndex + direction + supportedLanguages.length) % supportedLanguages.length;
    optionRefs.current[nextIndex]?.focus();
  };

  return (
    <div
      ref={rootRef}
      className={`language-select${open ? ' open' : ''}`}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setOpen(false);
      }}
    >
      <button
        ref={triggerRef}
        className="language-select-button"
        type="button"
        aria-label={t('common.language')}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={t('common.language')}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault();
            setOpen(true);
          }
        }}
      >
        <Languages size={15} aria-hidden="true" />
        <span className="language-current">{SHORT_LABELS[language]}</span>
        <ChevronDown className="language-chevron" size={14} aria-hidden="true" />
      </button>

      {open && (
        <ul id={menuId} className="language-select-menu" role="listbox" aria-label={t('common.language')}>
          {supportedLanguages.map((value, index) => (
            <li key={value} role="presentation">
              <button
                ref={(element) => { optionRefs.current[index] = element; }}
                className={`language-select-option${value === language ? ' active' : ''}`}
                type="button"
                role="option"
                aria-selected={value === language}
                onClick={() => chooseLanguage(value)}
                onKeyDown={(event) => {
                  if (event.key === 'ArrowDown') {
                    event.preventDefault();
                    moveFocus(index, 1);
                  } else if (event.key === 'ArrowUp') {
                    event.preventDefault();
                    moveFocus(index, -1);
                  } else if (event.key === 'Home') {
                    event.preventDefault();
                    optionRefs.current[0]?.focus();
                  } else if (event.key === 'End') {
                    event.preventDefault();
                    optionRefs.current[supportedLanguages.length - 1]?.focus();
                  }
                }}
              >
                <span className="language-option-code">{SHORT_LABELS[value]}</span>
                <span>{LABELS[value]}</span>
                {value === language && <Check size={15} aria-hidden="true" />}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
