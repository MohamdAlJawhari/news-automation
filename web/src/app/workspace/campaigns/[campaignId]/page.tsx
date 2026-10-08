import Link from "next/link";
import { CampaignShell } from "@/components/CampaignUI";
import { CampaignSourceForm } from "@/components/CampaignForms";
import { PublishingSettingsEditor } from "@/components/DirectPublishingControls";
import { campaignPage } from "@/lib/campaign-page";
import { prisma } from "@/lib/prisma";
import { connectedWorkspace } from "@/lib/ai-config";
import RefreshButton from "@/components/RefreshButton";
import CampaignToolbar from "@/components/CampaignToolbar";
import HelpButton from "@/components/HelpButton";
import OutlineIcon from "@/components/OutlineIcon";
export default async function Overview({params,searchParams}:{params:Promise<{campaignId:string}>;searchParams:Promise<{q?:string;sort?:string;view?:string}>}) {
 const {user,workspace,campaign,publishingSettings:settings}=await campaignPage(params);
 const query=await searchParams;const q=(typeof query.q==="string"?query.q:"").slice(0,200).trim();const sort=query.sort==="oldest"?"oldest":"newest";
 const sources=await prisma.sourceChannel.findMany({where:{workspaceId:workspace.id,...(q?{OR:[{username:{contains:q,mode:"insensitive" as const}},{title:{contains:q,mode:"insensitive" as const}}]}:{})},include:{campaignSources:{where:{workspaceId:workspace.id,campaignId:campaign.id}}},orderBy:[{createdAt:sort==="oldest"?"asc":"desc"},{id:sort==="oldest"?"asc":"desc"}]});
 const destinations=await prisma.campaignPublishingSettings.findMany({where:{workspaceId:workspace.id},select:{destinationUsername:true,destinationChatId:true}});
 const connected=connectedWorkspace(workspace.id);
 return <CampaignShell user={user} campaign={campaign} active="overview">
  <div className="flex flex-wrap items-center justify-between gap-3"><h2>Overview</h2><RefreshButton>Refresh status</RefreshButton></div>
  {!connected&&<p role="status" className="feedback-error">No connected Telegram account for this workspace. Ask the administrator about the connection.</p>}
  <div className="flex flex-wrap items-center justify-between gap-3"><div className="flex items-center gap-2"><h2>Sources & destination</h2><HelpButton label="source participation and connections">Connections represent configured participation, not live message delivery. Blue is active; muted is paused. Monitoring is separate. Joining starts paused without importing history. Pause/resume preserves eligible pending jobs and RSS remains independent.</HelpButton></div><Link className="button" href="/workspace/sources">Add / manage workspace sources</Link></div>
  <CampaignToolbar path={`/workspace/campaigns/${encodeURIComponent(campaign.id)}`} search={q} sort={sort} view="list" label="Search sources" displays={[]}/>
  <p className="muted text-sm">Connections show configured participation.</p>
  <div className="participation-flow">
   <section aria-label="Campaign sources" className={`source-flow-list ${sources.some(s=>s.campaignSources.length)?"has-members":""}`}>
    {!sources.length&&<div className="card p-6">{q?"No sources match your search.":"No workspace sources yet. Add a source to get started."}</div>}
    {sources.map(source=>{const member=source.campaignSources[0];const excluded=destinations.some(d=>d.destinationUsername===source.username||Boolean(source.telegramChatId&&source.telegramChatId===d.destinationChatId));return <div className="source-flow-row" data-joined={Boolean(member)} key={source.id}><article className="card p-5 space-y-3"><div className="flex items-center gap-3"><OutlineIcon name="sources"/><h3 dir="auto" className="break-words">{source.title||`@${source.username}`}</h3></div>{source.title&&<p className="muted break-words">@{source.username}</p>}<p className="muted">Workspace monitoring: <strong>{source.enabled?"Enabled":"Paused"}</strong></p>{source.enabled&&!source.telegramChatId&&<p className="muted text-sm">No posts received yet.</p>}{!source.enabled&&<p className="muted">Resume monitoring in Sources / RSS before work can run.</p>}{excluded&&<p className="feedback-error">A publishing destination cannot participate as a source.</p>}<CampaignSourceForm campaignId={campaign.id} sourceId={source.id} membership={member} excluded={excluded}/></article></div>;})}
   </section>
   <section className="card destination-flow-card p-6 space-y-4" aria-label="Campaign destination"><div className="flex items-center gap-3"><OutlineIcon name="send"/><h2>Destination</h2></div><h3 dir="auto" className="break-words">{settings.destinationUsername?`@${settings.destinationUsername}`:"Not configured"}</h3><p role="status">{settings.verificationPending?"Pending verification — refresh after the reader checks permission.":settings.verifiedAt?"Verified":"Not verified"}</p>{settings.verificationError&&<p className="feedback-error">{settings.verificationError}</p>}<PublishingSettingsEditor campaignId={campaign.id} connected={connected} settings={settings} mode="destination"/><details><summary>Details</summary><div className="pt-3 space-y-2 break-words"><p>Technical ID: {settings.destinationChatId||"Not available"}</p><p>Verified at: {settings.verifiedAt?.toISOString()||"Not verified"}</p></div></details></section>
  </div>
 </CampaignShell>;
}
