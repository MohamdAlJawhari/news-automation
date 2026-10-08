"use client";
import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

export default function HelpButton({ label, children }: { label: string; children: ReactNode }) {
  const id = useId();
  const anchor = useRef<HTMLButtonElement>(null);
  const bubble = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pinned, setPinned] = useState(false);
  const [position, setPosition] = useState({ top: 0, left: 0, width: 300 });
  function show() {
    const rect = anchor.current!.getBoundingClientRect();
    const width = Math.min(320, window.innerWidth - 24);
    setPosition({ top: Math.min(rect.bottom + 8, Math.max(12, window.innerHeight - 210)), left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width });
    setOpen(true);
  }
  useEffect(() => {
    if (!open) return;
    const close = () => { setOpen(false); setPinned(false); };
    const outside = (e: PointerEvent) => { if (!anchor.current?.contains(e.target as Node) && !bubble.current?.contains(e.target as Node)) close(); };
    const key = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); close(); } };
    const move = () => {
      const rect = anchor.current!.getBoundingClientRect(); const width = Math.min(320, window.innerWidth - 24);
      setPosition({ top: Math.max(12, Math.min(rect.bottom + 8, window.innerHeight - 210)), left: Math.max(12, Math.min(rect.left, window.innerWidth - width - 12)), width });
    };
    document.addEventListener("pointerdown", outside); document.addEventListener("keydown", key);
    window.addEventListener("resize", move); window.addEventListener("scroll", move, true);
    return () => { document.removeEventListener("pointerdown", outside); document.removeEventListener("keydown", key); window.removeEventListener("resize", move); window.removeEventListener("scroll", move, true); };
  }, [open]);
  return <><button ref={anchor} type="button" className="help-button" title={`Help about ${label}`} aria-label={`Help about ${label}`} aria-expanded={open} aria-controls={open ? id : undefined}
    onMouseEnter={show} onMouseLeave={() => { if (!pinned) setOpen(false); }} onFocus={show} onBlur={() => { if (!pinned) setOpen(false); }}
    onClick={() => { if (pinned) { setPinned(false); setOpen(false); } else { setPinned(true); show(); } }}>?</button>
    {open && createPortal(<div ref={bubble} id={id} role="note" className="help-popover" style={position}>{children}</div>, document.body)}</>;
}
