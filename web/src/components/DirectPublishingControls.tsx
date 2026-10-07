"use client";
import { useActionState, useState } from "react";
import { useUnsavedChanges } from "./useUnsavedChanges";
import CampaignDialog from "./CampaignDialog";
import { savePublishingSettings, publishAiDraft, recoverTelegramPublication, saveCampaignPublishingSettings, publishCampaignAiDraft, recoverCampaignTelegramPublication } from "@/app/actions/direct-publishing";
const initial = { success: false, message: "" };
type DestinationSettings = { enabled: boolean; destinationUsername: string; revision: number };
export function PublishingSettingsEditor({ settings, campaignId, connected = true }: { campaignId?: string; connected?: boolean; settings: DestinationSettings }) {
  const [revision, setRevision] = useState(settings.revision);
  const [enabled, setEnabled] = useState(settings.enabled);
  const [savedEnabled, setSavedEnabled] = useState(settings.enabled);
  const [savedDestination, setSavedDestination] = useState(settings.destinationUsername);
  const dirty = enabled !== savedEnabled;
  useUnsavedChanges(dirty);
  const [state, action, pending] = useActionState(async (previous: typeof initial, form: FormData) => {
    const result = await (campaignId ? saveCampaignPublishingSettings : savePublishingSettings)(previous, form);
    if (result.success) { setSavedEnabled(form.get("enabled") === "on"); setRevision(result.revision ?? revision); }
    return result;
  }, initial);
  return <div className="space-y-4"><CampaignDialog title="Change destination" label="Change destination">
    <DestinationEditor campaignId={campaignId} connected={connected && !pending} settings={{enabled:savedEnabled,destinationUsername:savedDestination,revision}} onSaved={(destination, nextRevision) => { setSavedDestination(destination); setRevision(nextRevision); }} />
    </CampaignDialog>
    <form action={action} data-unsaved={dirty} className="space-y-3">
      {campaignId && <input type="hidden" name="campaignId" value={campaignId} />}<input type="hidden" name="revision" value={revision} /><input type="hidden" name="destination" value={savedDestination} />
      <label className="flex gap-3"><input type="checkbox" name="enabled" checked={enabled} disabled={pending || !connected} onChange={event => setEnabled(event.target.checked)} />Enable manual Telegram publishing</label>
      <button className="button" disabled={pending || !connected || !savedDestination}>Save publishing control</button>
      {dirty && <p className="muted">Unsaved publishing control.</p>}
      <p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
    </form>
  </div>;
}
function DestinationEditor({ settings, campaignId, connected, onSaved }: { settings: DestinationSettings; campaignId?: string; connected: boolean; onSaved: (destination: string, revision: number) => void }) {
  const [dirty, setDirty] = useState(false);
  // Retain the edit token across external refreshes and control changes.
  const [revision, setRevision] = useState(settings.revision);
  useUnsavedChanges(dirty);
  const [state, action, pending] = useActionState(async (previous: typeof initial, form: FormData) => {
    const result = await (campaignId ? saveCampaignPublishingSettings : savePublishingSettings)(previous, form);
    if (result.success) { setDirty(false); setRevision(result.revision ?? revision); onSaved(String(form.get("destination")), result.revision ?? revision); }
    return result;
  }, initial);
  return <form action={action} data-unsaved={dirty} onChange={() => setDirty(true)} className="space-y-4">
    {campaignId && <input type="hidden" name="campaignId" value={campaignId} />}<input type="hidden" name="revision" value={revision} /><input type="hidden" name="enabled" value={settings.enabled ? "on" : ""} />
    <fieldset disabled={pending || !connected} className="space-y-4">
      <label htmlFor="destination">Destination channel</label><input id="destination" name="destination" defaultValue={settings.destinationUsername} placeholder="@news_output_test" required maxLength={200} className="field" />
      <p className="muted">Destination changes invalidate queued snapshots; they never redirect them. Disabling cannot recall a send already in flight.</p>
      <p className="muted">Verification checks posting permission and does not send a message.</p>
      <button className="button primary" name="verify" value="yes">Save &amp; verify</button>
    </fieldset>{dirty && <p className="muted">Unsaved destination settings.</p>}<p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
  </form>;
}
export function DirectPublishButton({ id, revision, disabled, campaignId }: { id: string; revision: number; disabled?: boolean; campaignId?: string }) {
  const [state, action, pending] = useActionState(campaignId ? publishCampaignAiDraft : publishAiDraft, initial);
  return <form action={action} className="space-y-2">{campaignId && <input type="hidden" name="campaignId" value={campaignId} />}<input type="hidden" name="draftId" value={id} /><input type="hidden" name="revision" value={revision} />
    <button className="button primary" disabled={pending || disabled}>{pending ? "Queuing…" : "Publish"}</button>
    <p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p></form>;
}
export function DirectPublicationRecovery({ id, campaignId }: { id: string; campaignId?: string }) {
  const [state, action, pending] = useActionState(campaignId ? recoverCampaignTelegramPublication : recoverTelegramPublication, initial);
  return <form action={action} className="space-y-3">{campaignId && <input type="hidden" name="campaignId" value={campaignId} />}<input type="hidden" name="publicationId" value={id} />
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
