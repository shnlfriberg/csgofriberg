import { useEffect, useId, useLayoutEffect, useRef, useState, type ButtonHTMLAttributes } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import type { EdgeEvidence } from "@friberg/card-link-core";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  first: string; second: string; evidence: EdgeEvidence[];
};
export default function ConnectionSlot({ first, second, evidence, ...props }: Props) {
  const { t } = useTranslation();
  const id = useId(), anchor = useRef<HTMLButtonElement>(null), panel = useRef<HTMLDivElement>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const [open, setOpen] = useState(false), [position, setPosition] = useState({ left: 0, top: 0 });
  const periods = [...new Map(evidence.map(e => [JSON.stringify([e.team, e.start, e.end]), e])).values()]
    .sort((a, b) => a.start.localeCompare(b.start) || a.team.localeCompare(b.team));
  const shown = open && periods.length > 0;
  const cancelClose = () => clearTimeout(timer.current);
  const show = () => { cancelClose(); if (periods.length) setOpen(true); };
  const hide = () => { cancelClose(); timer.current = setTimeout(() => setOpen(false), 100); };
  useEffect(() => () => clearTimeout(timer.current), []);
  useEffect(() => { setOpen(false); }, [first, second, evidence]);
  useLayoutEffect(() => {
    if (!shown) return;
    const place = () => {
      if (!anchor.current || !panel.current) return;
      const a = anchor.current.getBoundingClientRect(), p = panel.current.getBoundingClientRect();
      const left = Math.max(12, Math.min(window.innerWidth - p.width - 12, a.left + a.width / 2 - p.width / 2));
      const preferred = a.top >= p.height + 20 ? a.top - p.height - 8 : a.bottom + 8;
      setPosition({ left, top: Math.max(12, Math.min(window.innerHeight - p.height - 12, preferred)) });
    };
    const outside = (event: PointerEvent) => {
      if (!anchor.current?.contains(event.target as Node) && !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    place();
    window.addEventListener("scroll", place, true);
    window.addEventListener("resize", place);
    document.addEventListener("pointerdown", outside);
    return () => {
      window.removeEventListener("scroll", place, true);
      window.removeEventListener("resize", place);
      document.removeEventListener("pointerdown", outside);
    };
  }, [shown, first, second, evidence]);
  return <>
    <button {...props} ref={anchor} aria-describedby={shown ? id : undefined}
      onMouseEnter={e => { props.onMouseEnter?.(e); show(); }}
      onMouseLeave={e => { props.onMouseLeave?.(e); hide(); }}
      onFocus={e => { props.onFocus?.(e); show(); }}
      onBlur={e => { props.onBlur?.(e); hide(); }}
      onClick={e => { props.onClick?.(e); show(); }}
      onDragEnter={e => { props.onDragEnter?.(e); setOpen(false); }}
      onKeyDown={e => { props.onKeyDown?.(e); if (e.key === "Escape" && shown) { e.preventDefault(); e.stopPropagation(); setOpen(false); } }} />
    {shown && createPortal(<div ref={panel} id={id} role="tooltip" className="cl-connection-tooltip" style={position}
      onMouseEnter={cancelClose} onMouseLeave={hide}>
      <strong>{first} ↔ {second}</strong>
      <p>{t("card.sharedTeams")}</p>
      <ul>{periods.map(e => <li key={JSON.stringify([e.team, e.start, e.end])}>
        <b>{e.team}</b><span><time dateTime={e.start}>{e.start}</time> → <time dateTime={e.end}>{e.end}</time></span>
      </li>)}</ul>
      <small>{t("card.sharedPeriodNote")}</small>
    </div>, anchor.current?.closest('dialog') ?? document.body)}
  </>;
}
