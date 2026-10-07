import Link from "next/link";
import { CampaignShell } from "@/components/CampaignUI";
import { CampaignSourceForm } from "@/components/CampaignForms";
import { PublishingSettingsEditor } from "@/components/DirectPublishingControls";
import { campaignPage } from "@/lib/campaign-page";
import { prisma } from "@/lib/prisma";
import { connectedWorkspace } from "@/lib/ai-config";
import RefreshButton from "@/components/RefreshButton";
import CampaignToolbar from "@/components/CampaignToolbar";
export default async function Overview({ params, searchParams }: { params: Promise<{ campaignId: string }>; searchParams: Promise<{ q?: string; sort?: string; view?: string }> }) {
  const { user, workspace, campaign, aiSettings, publishingSettings: settings, telegramState } = await campaignPage(params);
  const query = await searchParams;
  const q = (typeof query.q === "string" ? query.q : "").slice(0, 200).trim();
  const sort = query.sort === "oldest" ? "oldest" : "newest";
  const view = query.view === "list" ? "list" : "grid";
  const sources = await prisma.sourceChannel.findMany({ where: { workspaceId: workspace.id, ...(q ? { OR: [{ username: { contains: q, mode: "insensitive" as const } }, { title: { contains: q, mode: "insensitive" as const } }] } : {}) }, include: { campaignSources: { where: { workspaceId: workspace.id, campaignId: campaign.id } } }, orderBy: [{ createdAt: sort === "oldest" ? "asc" : "desc" }, { id: sort === "oldest" ? "asc" : "desc" }] });
  const destinations = await prisma.campaignPublishingSettings.findMany({ where: { workspaceId: workspace.id }, select: { destinationUsername: true, destinationChatId: true } });
  const connected = connectedWorkspace(workspace.id);
  return <CampaignShell user={user} campaign={campaign} active="overview">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2>Overview</h2><RefreshButton>Refresh status</RefreshButton></div>
    {!connected && <p role="status" className="feedback-error">No connected Telegram account for this workspace. Ask the administrator about the connection.</p>}
    <section className="card p-6 space-y-4"><h2>Destination &amp; publishing</h2>
      <p className="break-words">Destination: <strong>{settings.destinationUsername ? `@${settings.destinationUsername}` : "Not configured"}</strong></p>
      <p role="status">{settings.verificationPending ? "Pending verification — refresh after the reader checks permission." : settings.verifiedAt ? `Verified ${settings.destinationChatId} at ${settings.verifiedAt.toISOString()}` : "Not verified"}</p>
      {settings.verificationError && <p className="feedback-error">{settings.verificationError}</p>}
      <PublishingSettingsEditor key={campaign.id} campaignId={campaign.id} connected={connected} settings={settings} />
      <p className="muted">AI preparation: {aiSettings.enabled ? "Enabled" : "Paused"}. AI preparation and manual publishing have separate controls. Approval never sends a message.</p>
      {telegramState.floodWaitUntil && telegramState.floodWaitUntil > new Date() && <p>Account-wide Telegram flood wait until {telegramState.floodWaitUntil.toISOString()}.</p>}
    </section>
    <section className="space-y-4"><div className="flex flex-wrap items-center justify-between gap-3"><h2>Source participation</h2><Link className="button" href="/workspace/sources">Manage workspace sources / RSS</Link></div>
      <p>Checked sources participate in this campaign. Workspace monitoring collects originals separately.</p>
      <p className="muted">Joining starts paused and does not import older posts. Resume can process retained eligible pending jobs. Pause preserves originals, drafts, backlog and the eligibility boundary. RSS runs independently.</p>
      <CampaignToolbar path={`/workspace/campaigns/${encodeURIComponent(campaign.id)}`} search={q} sort={sort} view={view} label="Search sources" displays={[{ value: "grid", label: "Grid display", icon: "grid" }, { value: "list", label: "List display", icon: "list" }]} />
      {!sources.length && <section className="card p-6">{q ? "No sources match your search." : "No workspace sources yet. Add a source through Sources / RSS."}</section>}
      <div className={`campaign-collection ${view}`}>{sources.map(source => {
        const member = source.campaignSources[0];
        const excluded = destinations.some(d => d.destinationUsername === source.username || Boolean(source.telegramChatId && source.telegramChatId === d.destinationChatId));
        return <article className="card campaign-card space-y-3" key={source.id}><h3 className="break-words">@{source.username}</h3>
          <p className="muted">Workspace monitoring: <strong>{source.enabled ? "Enabled" : "Paused"}</strong></p>
          {!source.enabled && <p className="muted">Resume workspace monitoring on Sources / RSS before work can run.</p>}
          {excluded && <p className="feedback-error">A publishing destination cannot participate as a source.</p>}
          <CampaignSourceForm key={`${source.id}-${member?.revision ?? 0}`} campaignId={campaign.id} sourceId={source.id} membership={member} excluded={excluded} />
        </article>;
      })}</div>
    </section>
  </CampaignShell>;
}
