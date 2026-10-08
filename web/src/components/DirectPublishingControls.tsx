"use client";
import { useActionState, useState } from "react";
import { useUnsavedChanges } from "./useUnsavedChanges";
import CampaignDialog from "./CampaignDialog";
import SettingSwitch, { useSettingSwitch } from "./SettingSwitch";
import HelpButton from "./HelpButton";
import { savePublishingSettings, publishAiDraft, recoverTelegramPublication, saveCampaignPublishingSettings, publishCampaignAiDraft, recoverCampaignTelegramPublication } from "@/app/actions/direct-publishing";
const initial = { success: false, message: "" };
type DestinationSettings = { enabled: boolean; destinationUsername: string; revision: number };
export function PublishingSettingsEditor({settings,campaignId,connected=true,mode="both"}:{campaignId?:string;connected?:boolean;settings:DestinationSettings;mode?:"both"|"destination"|"delivery"}) {
 const [destination,setDestination]=useState(settings.destinationUsername);
 const [revision,setRevision]=useState(settings.revision);
 const setting=useSettingSwitch(settings.enabled,revision,async(next,version)=>{
  const form=new FormData();if(campaignId)form.set("campaignId",campaignId);form.set("revision",String(version));form.set("intent","enablement");form.set("enabled",next?"on":"");
  return (campaignId?saveCampaignPublishingSettings:savePublishingSettings)(initial,form);
 });
 return <div className="space-y-4">
  {mode!=="delivery"&&<CampaignDialog title="Change destination" label="Change destination"><DestinationEditor campaignId={campaignId} connected={connected} settings={{enabled:setting.enabled,destinationUsername:destination,revision}} onSaved={(name,version)=>{setDestination(name);setRevision(version);}}/></CampaignDialog>}
  {mode!=="destination"&&<><div className="flex flex-wrap items-center gap-3"><SettingSwitch label="Enable Telegram publishing" checked={setting.enabled} pending={setting.pending} disabled={!connected} onChange={setting.change}/><HelpButton label="Telegram publishing">Publishing is required for manual Publish and Auto-send. Disabling pauses dispatch while retaining queued snapshots. Manual approval records review only. An authorized or in-flight send cannot be recalled.</HelpButton></div>
  {!connected&&<p className="feedback-error">No connected Telegram account for this workspace.</p>}
  <p role="status" className={setting.feedback.success?"feedback-success":"feedback-error"}>{setting.feedback.message}</p></>}
 </div>;
}
function DestinationEditor({settings,campaignId,connected,onSaved}:{settings:DestinationSettings;campaignId?:string;connected:boolean;onSaved:(destination:string,revision:number)=>void}) {
 const [value,setValue]=useState(settings.destinationUsername);
 const [saved,setSaved]=useState(value);
 const [revision,setRevision]=useState(settings.revision);
 const dirty=value!==saved;useUnsavedChanges(dirty);
 const [state,action,pending]=useActionState(async(previous:typeof initial,form:FormData)=>{
  const result=await (campaignId?saveCampaignPublishingSettings:savePublishingSettings)(previous,form);
  if(result.success){setSaved(String(form.get("destination")));setRevision(result.revision??revision);onSaved(String(form.get("destination")),result.revision??revision);}return result;
 },initial);
 return <form action={action} data-unsaved={dirty} className="space-y-4">
  {campaignId&&<input type="hidden" name="campaignId" value={campaignId}/>}<input type="hidden" name="revision" value={revision}/><input type="hidden" name="intent" value="destination"/>
  <fieldset disabled={pending||!connected} className="space-y-4"><label htmlFor="destination">Destination channel</label><input key={saved} id="destination" name="destination" value={value} onChange={e=>setValue(e.target.value)} placeholder="@news_output_test" required maxLength={200} className="field"/>
  <div className="flex items-center gap-2"><span>Destination verification</span><HelpButton label="destination verification">Verification checks posting permission without sending a message. Destination changes invalidate old snapshots and never redirect them.</HelpButton></div>
  <p className="muted">An authorized or in-flight send cannot be recalled by changing destination.</p><button className="button primary" name="verify" value="yes">{pending?"Verifying…":"Save & verify"}</button></fieldset>
  {dirty&&<p className="muted">Unsaved destination settings.</p>}<p role="status" className={state.success?"feedback-success":"feedback-error"}>{state.message}</p>
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
