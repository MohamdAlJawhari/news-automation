"use client";
import { useRef } from "react";
import { changeAutoSend } from "@/app/actions/auto-send";
import SettingSwitch, { useSettingSwitch } from "./SettingSwitch";
import HelpButton from "./HelpButton";
export default function AutoSendControl({campaignId,enabled,revision,destinationRevision,destinationChatId,destinationUsername}:{campaignId:string;enabled:boolean;revision:number;destinationRevision:number;destinationChatId:string|null;destinationUsername:string}) {
 const dialog=useRef<HTMLDialogElement>(null);
 const setting=useSettingSwitch(enabled,revision,async(next,version)=>{
  const form=new FormData();form.set("campaignId",campaignId);form.set("revision",String(version));form.set("destinationRevision",String(destinationRevision));form.set("destinationChatId",destinationChatId||"");form.set("enabled",next?"yes":"no");if(next)form.set("confirmed","yes");
  const result=await changeAutoSend({success:false,message:""},form);if(result.success)dialog.current?.close();return result;
 });
 if(!Number.isSafeInteger(revision)||revision<1)return <p role="status" className="feedback-error">Auto-send is unavailable: this server still uses the previous database/client version. The administrator must complete rollout.</p>;
 return <div className="space-y-3"><div className="flex flex-wrap items-center gap-3"><SettingSwitch label="Auto-send" checked={setting.enabled} pending={setting.pending} onChange={next=>{if(next)dialog.current?.showModal();else void setting.change(false);}}/><HelpButton label="Auto-send">Future eligible posts are automatically approved and queued through the existing publisher. Earlier drafts and activation generations remain manual. Turning this off retains drafts and history; manually queued publications are unaffected.</HelpButton></div>
 <p role="status" className={setting.feedback.success?"feedback-success":"feedback-error"}>{setting.feedback.message}</p>
 <dialog ref={dialog} className="campaign-dialog" aria-label="Enable Auto-send" onClose={()=>dialog.current?.querySelector('form')?.reset()} onCancel={e=>{if(setting.pending)e.preventDefault();}}>
  <div className="flex justify-between gap-3"><h2>Enable Auto-send</h2><button type="button" className="button" disabled={setting.pending} onClick={()=>dialog.current?.close()}>Cancel</button></div>
  <form className="space-y-4 pt-4" onSubmit={e=>{e.preventDefault();void setting.change(true);}}>
   <p>Future eligible posts will publish without human review to <strong>@{destinationUsername} ({destinationChatId||"unverified"})</strong>. Existing drafts remain manual.</p>
   <p>An authorized or in-flight send cannot be recalled by turning Auto-send off.</p>
   <label className="flex gap-3"><input type="checkbox" name="confirmed" value="yes" required disabled={setting.pending}/>I confirm automatic publishing to this destination.</label>
   <button className="button primary" disabled={setting.pending}>{setting.pending?"Saving…":"Confirm and enable Auto-send"}</button>
   {!setting.feedback.success&&<p role="status" className="feedback-error">{setting.feedback.message}</p>}
  </form>
 </dialog></div>;
}
