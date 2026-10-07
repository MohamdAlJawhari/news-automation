import Link from "next/link";
import { WorkspaceShell } from "@/components/WorkspaceUI";
import { CampaignNameForm, CampaignDeleteForm } from "@/components/CampaignForms";
import CampaignDialog from "@/components/CampaignDialog";
import OutlineIcon from "@/components/OutlineIcon";
import CampaignToolbar from "@/components/CampaignToolbar";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { prisma } from "@/lib/prisma";
export default async function CampaignsPage({ searchParams }: { searchParams: Promise<{ q?: string; sort?: string; view?: string }> }) {
  const { user, workspace } = await requireWorkspaceAccess("automation");
  const query = await searchParams;
  const q = (typeof query.q === "string" ? query.q : "").slice(0, 200).trim();
  const sort = query.sort === "oldest" ? "oldest" : "newest";
  const view = query.view === "list" ? "list" : "grid";
  const campaigns = await prisma.campaign.findMany({ where: { workspaceId: workspace.id, ...(q ? { name: { contains: q, mode: "insensitive" as const } } : {}) },
    include: { aiSettings: true, publishingSettings: true, _count: { select: { sources: true, processingJobs: true, aiDrafts: true } } },
    orderBy: [{ createdAt: sort === "oldest" ? "asc" : "desc" }, { id: sort === "oldest" ? "asc" : "desc" }] });
  const pending = await prisma.aiDraft.groupBy({ by: ["campaignId"], where: { workspaceId: workspace.id, reviewStatus: "PENDING_REVIEW" }, _count: true });
  return <WorkspaceShell user={user} active="campaigns">
    <header className="flex flex-wrap items-center justify-between gap-4"><div><h1>Campaigns</h1><p className="muted mt-2">An editorial workflow for each audience.</p></div>
      <CampaignDialog title="Create campaign" label="Create campaign" primary><p className="muted mb-4">New campaigns start paused with no selected sources.</p><CampaignNameForm /></CampaignDialog></header>
    <CampaignToolbar path="/workspace/campaigns" search={q} sort={sort} view={view} label="Search campaigns" displays={[{ value: "grid", label: "Grid display", icon: "grid" }, { value: "list", label: "List display", icon: "list" }]} />
    {!campaigns.length && <section className="card p-6">No campaigns match your search.</section>}
    <div className={`campaign-collection ${view}`}>{campaigns.map(c => <article className="card campaign-card space-y-3" key={c.id}>
      <div className="flex justify-between items-start gap-3"><div className="min-w-0"><h2 dir="auto" className="break-words"><Link href={`/workspace/campaigns/${encodeURIComponent(c.id)}`}>{c.name}</Link></h2>{c.isDefault && <span className="status">Default</span>}</div>
        <details className="overflow-actions"><summary aria-label={`Actions for ${c.name}`} title="Campaign actions"><OutlineIcon name="more" /></summary><div className="overflow-panel space-y-3">
          <CampaignDialog title="Rename campaign" label="Rename"><CampaignNameForm campaign={{ id: c.id, name: c.name, updatedAt: c.updatedAt.toISOString() }} /></CampaignDialog>
          {!c.isDefault && !c._count.sources && !c._count.processingJobs && !c._count.aiDrafts && <CampaignDialog title="Delete empty campaign" label="Delete empty campaign"><CampaignDeleteForm campaignId={c.id} name={c.name} /></CampaignDialog>}
          {(c._count.sources > 0 || c._count.processingJobs > 0 || c._count.aiDrafts > 0) && <p className="muted text-sm">History is protected; this campaign cannot be deleted.</p>}
        </div></details></div>
      <p className="muted break-words">Destination: {c.publishingSettings?.destinationUsername ? `@${c.publishingSettings.destinationUsername}` : "Not configured"}</p>
      <div className="flex flex-wrap gap-2"><span className={`status ${c.aiSettings?.enabled ? "" : "paused"}`}>AI {c.aiSettings?.enabled ? "enabled" : "paused"}</span><span className={`status ${c.publishingSettings?.enabled ? "" : "paused"}`}>Publishing {c.publishingSettings?.enabled ? "enabled" : "paused"}</span></div>
      <p>{pending.find(d => d.campaignId === c.id)?._count ?? 0} pending review</p>
    </article>)}</div>
  </WorkspaceShell>;
}
