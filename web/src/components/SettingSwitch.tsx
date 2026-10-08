"use client";
import { useEffect, useRef, useState } from "react";

export type SwitchResult = { success: boolean; message: string; enabled?: boolean; revision?: number };
export function useSettingSwitch(enabled: boolean, revision: number, save: (next: boolean, revision: number) => Promise<SwitchResult>) {
  const [confirmed, setConfirmed] = useState({ enabled, revision });
  const current = useRef(confirmed);
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [feedback, setFeedback] = useState<SwitchResult>({ success: true, message: "" });
  useEffect(() => {
    if (revision > current.current.revision) {
      current.current = { enabled, revision }; setConfirmed(current.current);
    }
  }, [enabled, revision]);
  async function change(next: boolean) {
    if (busy.current) return;
    busy.current = true; setPending(true);
    const version = current.current.revision;
    try {
      const result = await save(next, version);
      if (current.current.revision !== version) return;
      if (result.enabled !== undefined && (result.revision ?? version) >= version) {
        current.current = { enabled: result.enabled, revision: result.revision ?? version };
        setConfirmed(current.current);
      }
      setFeedback(result);
    } catch { setFeedback({ success: false, message: "Could not save. The previous state is retained. Try again or reload." }); }
    finally { busy.current = false; setPending(false); }
  }
  return { ...confirmed, pending, feedback, change };
}
export default function SettingSwitch({ label, checked, pending = false, disabled = false, onChange }: { label: string; checked: boolean; pending?: boolean; disabled?: boolean; onChange: (next: boolean) => void }) {
  return <div className="setting-switch-row"><span>{label}</span><button type="button" role="switch" aria-label={label} title={label} aria-checked={checked} aria-busy={pending} disabled={pending || disabled} className="setting-switch" onClick={() => onChange(!checked)}><span /></button><span className="muted text-sm" aria-live="polite">{pending ? "Saving…" : checked ? "On" : "Off"}</span></div>;
}
