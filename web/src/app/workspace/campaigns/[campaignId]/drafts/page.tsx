import { listCampaignDrafts } from "@/lib/campaign-drafts";
import { campaignPage } from "@/lib/campaign-page";
import { connectedWorkspace } from "@/lib/ai-config";
import Link from "next/link";
import { CampaignShell } from "@/components/CampaignUI";
import AiDraftEditor from "@/components/AiDraftEditor";
import { prisma } from "@/lib/prisma";
import { BLOCKING_PUBLICATIONS, publishedLink } from "@/lib/publishing-config";
import { DirectPublicationRecovery } from "@/components/DirectPublishingControls";
import RefreshButton from "@/components/RefreshButton";
import CampaignToolbar from "@/components/CampaignToolbar";

export default async function AiDraftsPage({ searchParams, params }: { params: Promise<{ campaignId: string }>; searchParams: Promise<{ page?: string; q?: string; sort?: string; view?: string }> }) {
  const { user, workspace, campaign, publishingSettings: settings, aiSettings } = await campaignPage(params);
  const memberships = await prisma.campaignSource.findMany({ where: { workspaceId: workspace.id, campaignId: campaign.id }, include: { sourceChannel: { select: { enabled: true } } } });
  const query = await searchParams;
  const page = Math.min(100000, Math.max(1, Number.parseInt(query.page || "1", 10) || 1));
  const q = (typeof query.q === "string" ? query.q : "").slice(0, 200).trim();
  const sort = query.sort === "oldest" ? "oldest" : "newest";
  const view = query.view === "compare" ? "compare" : "cards";
  const { drafts, failures } = await prisma.$transaction(tx => listCampaignDrafts(tx, workspace.id, campaign.id, page, { search: q, sort }));
  const pageLink = (next: number) => `?${new URLSearchParams({ q, sort, view, page: String(next) })}`;
  return <CampaignShell campaign={campaign} user={user} active="ai-drafts">
    <div className="flex flex-wrap justify-between gap-4"><h2>Drafts</h2><RefreshButton>Refresh status</RefreshButton></div>
    <p>Campaign mode: <strong>{campaign.autoSendEnabled ? "Auto-send on — future eligible posts publish without human review" : "Auto-send off — manual review"}</strong>. Existing drafts remain manual.</p>
    <p className="muted">Save edits, then Approve. Publish separately queues the saved and approved text. Plain text is limited to 4,096 UTF-16 characters.</p>
    {!connectedWorkspace(workspace.id) && <p className="feedback-error" role="status">AI preparation and publishing need a connected Telegram account for this workspace.</p>}
    {!memberships.some(m => m.telegramAutomationEnabled && m.sourceChannel.enabled) && <p className="muted">Join a source and resume its participation and workspace monitoring before new drafts can be prepared.</p>}
    {!aiSettings.enabled && <p className="muted">AI preparation is paused. Existing drafts remain editable, and manual publishing uses its own settings.</p>}
    {failures.length > 0 && <section className="card p-6 space-y-3"><h2>Preparation failures</h2>{failures.map(job => <p key={job.id}>{job.id}: {job.lastError}</p>)}</section>}
    <CampaignToolbar path={`/workspace/campaigns/${encodeURIComponent(campaign.id)}/drafts`} search={q} sort={sort} view={view} label="Search drafts" displays={[{ value: "cards", label: "Cards display", icon: "grid" }, { value: "compare", label: "Compare display", icon: "compare" }]} />
    <div className={`draft-collection ${view}`}>
    {drafts.length === 0 && <section className="card p-6">No drafts match these filters on this page. Check source participation in Overview and AI preparation in Settings if you are waiting for new drafts.</section>}
    {drafts.slice(0, 20).map(draft => <article className="card p-6 space-y-5" key={draft.id}>
      <h2>@{draft.originalPost.sourceChannel.username}</h2>
      <p className="muted">{draft.reviewStatus === "APPROVED" && draft.approvalMode === "AUTOMATIC" ? "Automatically approved" : draft.reviewStatus.replaceAll("_", " ")} · {draft.model} · Settings revision {draft.settingsRevision} · Received {draft.originalPost.receivedAt.toISOString()}</p>
      {draft.manualAttentionReason && <p role="status">Manual attention: {draft.manualAttentionReason}</p>}
      <div className={view === "compare" ? "compare-layout" : "space-y-4"}>
      {view === "compare" ? <section><h3>Original post</h3><p dir="auto" className="text-content">{draft.originalPost.originalText}</p></section> : <details><summary>Original post</summary><p dir="auto" className="text-content pt-3">{draft.originalPost.originalText}</p></details>}
      <AiDraftEditor key={draft.id} campaignId={campaign.id} publishingUnavailable={!connectedWorkspace(workspace.id) ? "No connected Telegram account for this workspace." : !draft.originalPost.sourceChannel.enabled ? "Workspace source monitoring is paused." : !memberships.some(m => m.sourceChannelId === draft.originalPost.sourceChannelId && m.telegramAutomationEnabled) ? "Participation for this source is paused or unavailable in this campaign." : !settings.enabled ? "Manual publishing is paused for this campaign." : !settings.verifiedAt || settings.verificationPending ? "Publishing waits for a verified destination. Check Overview." : undefined} draft={draft} published={draft.publications.some(p => p.status === "PUBLISHED")} locked={draft.publications.some(p => BLOCKING_PUBLICATIONS.includes(p.status as typeof BLOCKING_PUBLICATIONS[number]))} />
      </div><details><summary>Original AI output</summary><p dir="auto" className="text-content pt-3">{draft.aiText}</p><p className="muted text-sm">Stored AI output is preserved separately from manual edits.</p></details>
      {draft.publications.map(p => <section key={p.id} className="space-y-3 border-t pt-4">
        <h3>Telegram publication: {p.status === "DELIVERY_UNKNOWN" ? "Delivery unknown" : p.status.toLowerCase()}</h3>
        <p className="muted">{p.deliveryMode === "AUTOMATIC" ? "Automatic publication" : "Manual publication"} · Snapshot revision {p.draftRevision} · @{p.destinationUsername} · {p.destinationChatId}{p.publishedAt ? ` · Published ${p.publishedAt.toISOString()}` : ""}</p>
        {p.lastError && <p role="status">{p.lastError}</p>}
        {publishedLink(p.confirmedChatId, p.telegramMessageId) && <a className="button" href={publishedLink(p.confirmedChatId, p.telegramMessageId)!} target="_blank" rel="noopener noreferrer">View published message</a>}
        {p.status === "DELIVERY_UNKNOWN" && <DirectPublicationRecovery campaignId={campaign.id} id={p.id} />}
      </section>)}
    </article>)}
    </div><nav aria-label="Draft pages" className="flex gap-3">{page > 1 && <Link className="button" href={pageLink(page - 1)}>Previous</Link>}{drafts.length > 20 && <Link className="button" href={pageLink(page + 1)}>Next</Link>}</nav>
  </CampaignShell>;
}
