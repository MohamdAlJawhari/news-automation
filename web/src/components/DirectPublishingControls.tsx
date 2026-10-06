"use client";
import { useActionState } from "react";
import { savePublishingSettings, publishAiDraft, recoverTelegramPublication } from "@/app/actions/direct-publishing";
const initial = { success: false, message: "" };
export function PublishingSettingsEditor({ settings }: { settings: { enabled: boolean; destinationUsername: string; revision: number } }) {
  const [state, action, pending] = useActionState(savePublishingSettings, initial);
  return <form action={action} className="card p-6 space-y-4">
    <input type="hidden" name="revision" value={settings.revision} />
    <fieldset disabled={pending} className="space-y-4">
      <label htmlFor="destination">Destination channel</label><input id="destination" name="destination" defaultValue={settings.destinationUsername} placeholder="@news_output_test" required maxLength={200} className="field" />
      <label className="flex gap-3"><input type="checkbox" name="enabled" defaultChecked={settings.enabled} />Enable manual Telegram publishing</label>
      <p className="muted">Publishing starts disabled. One destination per workspace. Destination changes invalidate queued snapshots; they never redirect them. Disabling cannot recall a send already in flight.</p>
      <div className="flex gap-3"><button className="button primary">Save settings</button><button className="button" name="verify" value="yes">Save and verify destination</button></div>
    </fieldset><p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
  </form>;
}
export function DirectPublishButton({ id, revision, disabled }: { id: string; revision: number; disabled?: boolean }) {
  const [state, action, pending] = useActionState(publishAiDraft, initial);
  return <form action={action} className="space-y-2"><input type="hidden" name="id" value={id} /><input type="hidden" name="revision" value={revision} />
    <button className="button primary" disabled={pending || disabled}>{pending ? "Queuing…" : "Publish"}</button>
    <p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p></form>;
}
export function DirectPublicationRecovery({ id }: { id: string }) {
  const [state, action, pending] = useActionState(recoverTelegramPublication, initial);
  return <form action={action} className="space-y-3"><input type="hidden" name="id" value={id} />
    <p>Delivery is unknown. Inspect the pinned destination in Telegram. No automatic resend will occur.</p>
    <fieldset disabled={pending} className="space-y-3">
      <label>Existing message ID<input type="number" name="messageId" min={1} max={2147483647} className="field" /></label>
      <button className="button" name="intent" value="existing">Verify and record existing message</button>
      <p className="muted">To confirm nothing was sent: stop the reader, wait at least ten minutes after dispatch, inspect Telegram, then confirm below. Restart the reader after recovery.</p>
      <label className="flex gap-3"><input type="checkbox" name="confirmed" />I stopped the reader and confirmed no matching message was sent.</label>
      <button className="button" name="intent" value="none">Confirm nothing was sent</button>
    </fieldset><p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
  </form>;
}
