import Link from "next/link";
import { WorkspaceShell } from "@/components/WorkspaceUI";
import AiDraftEditor from "@/components/AiDraftEditor";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { prisma } from "@/lib/prisma";
import { BLOCKING_PUBLICATIONS, publishedLink } from "@/lib/publishing-config";
import { DirectPublicationRecovery } from "@/components/DirectPublishingControls";
import RefreshButton from "@/components/RefreshButton";

export default async function AiDraftsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { user, workspace } = await requireWorkspaceAccess("automation");
  const query = await searchParams;
  const page = Math.min(100000, Math.max(1, Number.parseInt(query.page || "1", 10) || 1));
  const drafts = await prisma.aiDraft.findMany({ where: { workspaceId: workspace.id },
    include: { originalPost: { include: { sourceChannel: true } }, publications: { orderBy: { createdAt: "desc" } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 20, take: 21 });
  const failures = await prisma.processingJob.findMany({ where: { workspaceId: workspace.id, type: "TELEGRAM_PREPARE", status: "FAILED" }, select: { id: true, lastError: true }, orderBy: { updatedAt: "desc" }, take: 5 });
  return <WorkspaceShell user={user} active="ai-drafts">
    <div className="flex flex-wrap justify-between gap-4"><h1>AI Drafts</h1><Link className="button" href="/workspace/publishing">Publishing settings</Link><RefreshButton>Refresh status</RefreshButton></div>
    <p className="muted">Save edits, then Approve. Publish separately queues the saved and approved text. Plain text is limited to 4,096 UTF-16 characters.</p>
    {failures.length > 0 && <section className="card p-6 space-y-3"><h2>Preparation failures</h2>{failures.map(job => <p key={job.id}>{job.id}: {job.lastError}</p>)}</section>}
    {drafts.length === 0 && <section className="card p-6">No AI drafts on this page. Enable AI settings and run the Telegram preparation worker to process eligible new posts.</section>}
    {drafts.slice(0, 20).map(draft => <article className="card p-6 space-y-5" key={draft.id}>
      <h2>@{draft.originalPost.sourceChannel.username}</h2>
      <p className="muted">{draft.reviewStatus.replaceAll("_", " ")} · {draft.model} · Settings revision {draft.settingsRevision} · Received {draft.originalPost.receivedAt.toISOString()}</p>
      <div className="grid md:grid-cols-2 gap-6"><section><h3>Original text</h3><p dir="auto" className="text-content">{draft.originalPost.originalText}</p></section><section><h3>AI rewrite</h3><p dir="auto" className="text-content">{draft.aiText}</p></section></div>
      <AiDraftEditor key={`${draft.id}-${draft.editRevision}`} draft={draft} locked={draft.publications.some(p => BLOCKING_PUBLICATIONS.includes(p.status as typeof BLOCKING_PUBLICATIONS[number]))} />
      {draft.publications.map(p => <section key={p.id} className="space-y-3 border-t pt-4">
        <h3>Telegram publication: {p.status === "DELIVERY_UNKNOWN" ? "Delivery unknown" : p.status.toLowerCase()}</h3>
        <p className="muted">Snapshot revision {p.draftRevision} · @{p.destinationUsername} · {p.destinationChatId}{p.publishedAt ? ` · Published ${p.publishedAt.toISOString()}` : ""}</p>
        {p.lastError && <p role="status">{p.lastError}</p>}
        {publishedLink(p.confirmedChatId, p.telegramMessageId) && <a className="button" href={publishedLink(p.confirmedChatId, p.telegramMessageId)!} target="_blank" rel="noopener noreferrer">View published message</a>}
        {p.status === "DELIVERY_UNKNOWN" && <DirectPublicationRecovery id={p.id} />}
      </section>)}
    </article>)}
    <nav aria-label="Draft pages" className="flex gap-3">{page > 1 && <Link className="button" href={`?page=${page - 1}`}>Previous</Link>}{drafts.length > 20 && <Link className="button" href={`?page=${page + 1}`}>Next</Link>}</nav>
  </WorkspaceShell>;
}
