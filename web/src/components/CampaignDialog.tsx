"use client";
import { useRef, type ReactNode } from "react";
import OutlineIcon from "./OutlineIcon";
export default function CampaignDialog({ title, label, children, primary = false }: { title: string; label: string; children: ReactNode; primary?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  function close() {
    if (dialog.current?.querySelector('[data-unsaved="true"]') && !window.confirm("Close with unsaved changes? Your edits remain in this dialog.")) return;
    dialog.current?.close();
    trigger.current?.focus();
  }
  return <><button ref={trigger} type="button" className={`button ${primary ? "primary" : ""}`} onClick={() => dialog.current?.showModal()}>{primary && <OutlineIcon name="plus" />}{label}</button>
    <dialog ref={dialog} className="campaign-dialog" aria-label={title} onClose={() => trigger.current?.focus()} onCancel={event => { event.preventDefault(); close(); }}>
      <div className="flex items-center justify-between gap-3"><h2>{title}</h2><button type="button" className="button" onClick={close}>Close</button></div>
      <div className="pt-5">{children}</div>
    </dialog></>;
}
