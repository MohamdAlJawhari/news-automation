"use client";
import { useEffect, useRef, useState } from "react";
import { useUnsavedChanges } from "./useUnsavedChanges";
import { saveAiSettings, saveCampaignAiSettings } from "@/app/actions/ai";
import SettingSwitch from "./SettingSwitch";
import HelpButton from "./HelpButton";
export default function AiSettingsEditor({ settings, models, connected, campaignId }: {
 settings: { enabled: boolean; systemPrompt: string; editorialPerspective: string; model: string; revision: number }; models: readonly string[]; connected: boolean; campaignId?: string;
}) {
 const [enabled,setEnabled]=useState(settings.enabled);
 const [revision,setRevision]=useState(settings.revision);
 const [content,setContent]=useState({model:settings.model,systemPrompt:settings.systemPrompt,editorialPerspective:settings.editorialPerspective});
 const [saved,setSaved]=useState(content);
 const dirty=JSON.stringify(content)!==JSON.stringify(saved);
 const [pending,setPending]=useState<"switch"|"content"|null>(null);
 const busy=useRef(false);
 const latestServer=useRef(settings);
 const [feedback,setFeedback]=useState({success:true,message:""});
 useUnsavedChanges(dirty);
 useEffect(()=>{
  if(settings.revision<=latestServer.current.revision)return;
  latestServer.current=settings;
  // An external server revision is authoritative; only clean editors can adopt its content.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  if(!busy.current){setEnabled(settings.enabled);if(!dirty){setRevision(settings.revision);const next={model:settings.model,systemPrompt:settings.systemPrompt,editorialPerspective:settings.editorialPerspective};setContent(next);setSaved(next);}else setFeedback({success:false,message:"AI settings changed elsewhere. Keep your unsaved edits and reload before saving."});}
 },[settings,dirty]);
 async function save(intent:"enablement"|"content",nextEnabled=enabled) {
  if(busy.current)return; busy.current=true;setPending(intent==="enablement"?"switch":"content");
  const snapshot={...content};const form=new FormData();
  if(campaignId)form.set("campaignId",campaignId);
  form.set("revision",String(revision));form.set("intent",intent);form.set("enabled",nextEnabled?"on":"");
  if(intent==="content")for(const [key,value] of Object.entries(snapshot))form.set(key,value);
  try {
   const result=await (campaignId?saveCampaignAiSettings:saveAiSettings)({success:true,message:"",revision},form);
   if(result.success&&result.revision<latestServer.current.revision){setEnabled(latestServer.current.enabled);setFeedback({success:false,message:"A newer AI settings revision is available. Keep your edits and reload."});return;}
   if(result.enabled!==undefined)setEnabled(result.enabled);
   if(result.success){setRevision(result.revision);if(intent==="content")setSaved(snapshot);}
   setFeedback(result);
  }catch{setFeedback({success:false,message:"Could not save AI settings. Your previous state and unsaved edits are retained."});}
  finally{busy.current=false;setPending(null);}
 }
 return <div className="space-y-5">
  <div className="flex flex-wrap items-center gap-3"><SettingSwitch label="Enable AI preparation" checked={enabled} pending={pending==="switch"} disabled={!connected||pending!==null} onChange={next=>void save("enablement",next)}/><HelpButton label="AI preparation">First activation includes only posts received afterward. Pause/resume retains that boundary and eligible pending jobs. This switch saves only enablement; model and prompt edits remain unsaved until you save them.</HelpButton></div>
  <form onSubmit={event=>{event.preventDefault();void save("content");}} data-unsaved={dirty} className="space-y-5">
   <input type="hidden" name="revision" value={revision}/>
   <div><label htmlFor="ai-model">Local model</label><select id="ai-model" name="model" value={content.model} onChange={e=>setContent({...content,model:e.target.value})} className="field">{models.map(model=><option key={model}>{model}</option>)}</select></div>
   <div><div className="flex items-center gap-2"><label htmlFor="ai-perspective">Editorial instructions</label><HelpButton label="editorial instructions and prompt">Leave instructions empty for a straightforward news-reporting tone. The advanced prompt provides the base rewriting instructions.</HelpButton></div><textarea id="ai-perspective" name="editorialPerspective" value={content.editorialPerspective} onChange={e=>setContent({...content,editorialPerspective:e.target.value})} maxLength={2000} rows={2} dir="auto" className="field"/></div>
   <details><summary>Advanced prompt</summary><div className="pt-3"><label htmlFor="ai-system">System prompt</label><textarea id="ai-system" name="systemPrompt" value={content.systemPrompt} onChange={e=>setContent({...content,systemPrompt:e.target.value})} required maxLength={20000} rows={12} dir="auto" className="field"/></div></details>
   <button className="button primary" disabled={pending!==null}>{pending==="content"?"Saving…":"Save AI settings"}</button>
   {dirty&&<p className="muted">Unsaved AI settings.</p>}
  </form><p role="status" className={feedback.success?"feedback-success":"feedback-error"}>{feedback.message}</p>
 </div>;
}
