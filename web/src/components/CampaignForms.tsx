"use client";
import Link from "next/link";
import { useActionState, useState } from "react";
import { useUnsavedChanges } from "./useUnsavedChanges";
import { createCampaignAction, renameCampaign, changeCampaignSource, deleteEmptyCampaign, type CampaignActionState } from "@/app/actions/campaigns";
const initial: CampaignActionState = { success: false, message: "" };
export function CampaignNameForm({ campaign }: { campaign?: { id: string; name: string; updatedAt: string } }) {
  const [dirty, setDirty] = useState(false);
  const [version, setVersion] = useState(campaign?.updatedAt ?? "");
  useUnsavedChanges(dirty);
  const [state, action, pending] = useActionState(async (previous: CampaignActionState, form: FormData) => {
    const result = await (campaign ? renameCampaign : createCampaignAction)(previous, form);
    if (result.success) { setDirty(false); if (result.updatedAt) setVersion(result.updatedAt); }
    return result;
  }, initial);
  return <form action={action} data-unsaved={dirty} onChange={() => setDirty(true)} className="space-y-3">
    {campaign && <><input type="hidden" name="campaignId" value={campaign.id} /><input type="hidden" name="updatedAt" value={version} /></>}
    <label htmlFor={`campaign-name-${campaign?.id ?? "new"}`}>{campaign ? "Campaign name" : "New campaign name"}</label>
    <div className="flex flex-wrap gap-3"><input id={`campaign-name-${campaign?.id ?? "new"}`} name="name" defaultValue={campaign?.name ?? ""} placeholder="e.g. Local news" required maxLength={100} dir="auto" className="field flex-1 min-w-0" disabled={pending} /><button className="button primary" disabled={pending}>{pending ? "Saving…" : campaign ? "Rename" : "Create campaign"}</button></div>
    <p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
    {state.success && state.campaignId && <Link className="button" href={`/workspace/campaigns/${encodeURIComponent(state.campaignId)}`}>Open campaign</Link>}
  </form>;
}
export function CampaignSourceForm({ campaignId, sourceId, membership, excluded }: { campaignId: string; sourceId: string; membership?: { revision: number; telegramAutomationEnabled: boolean }; excluded: boolean }) {
  const [state, action, pending] = useActionState(changeCampaignSource, initial);
  const intent = !membership ? "join" : membership.telegramAutomationEnabled ? "pause" : "resume";
  return <form action={action} className="space-y-2"><input type="hidden" name="campaignId" value={campaignId} /><input type="hidden" name="sourceId" value={sourceId} /><input type="hidden" name="revision" value={membership?.revision ?? 0} />
    <label className="flex gap-3 items-center"><input type="checkbox" aria-label="Participate in this campaign" checked={Boolean(membership?.telegramAutomationEnabled)} disabled={!membership || pending || (excluded && intent !== "pause")} onChange={event => { const form = event.currentTarget.form!; form.requestSubmit(form.querySelector('button')!); }} />Participate in this campaign</label>
    <button className="button" hidden={Boolean(membership)} name="intent" value={intent} disabled={pending || (excluded && intent !== "pause")}>{pending ? "Saving…" : intent === "join" ? "Join campaign (paused)" : intent === "pause" ? "Pause participation" : "Resume participation"}</button>
    <p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
  </form>;
}
export function CampaignDeleteForm({ campaignId, name }: { campaignId: string; name: string }) {
  const [state, action, pending] = useActionState(deleteEmptyCampaign, initial);
  return <form action={action} className="space-y-3"><input type="hidden" name="campaignId" value={campaignId} />
    <p>Delete <strong dir="auto">{name}</strong> permanently? Campaigns with source membership history, jobs, drafts or publications cannot be deleted.</p>
    <label className="flex gap-3"><input type="checkbox" name="confirmed" value="yes" required />Confirm permanent deletion</label>
    <button className="button danger" disabled={pending}>{pending ? "Checking…" : "Delete campaign"}</button>
    <p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
  </form>;
}
