import Link from "next/link";
import { WorkspaceShell } from "@/components/WorkspaceUI";
import AiDraftEditor from "@/components/AiDraftEditor";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { prisma } from "@/lib/prisma";

export default async function AiDraftsPage({ searchParams }: { searchParams: Promise<{ page?: string }> }) {
  const { user, workspace } = await requireWorkspaceAccess("automation");
  const query = await searchParams;
  const page = Math.min(100000, Math.max(1, Number.parseInt(query.page || "1", 10) || 1));
  const drafts = await prisma.aiDraft.findMany({ where: { workspaceId: workspace.id },
    include: { originalPost: { include: { sourceChannel: true } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }], skip: (page - 1) * 20, take: 21 });
  const failures = await prisma.processingJob.findMany({ where: { workspaceId: workspace.id, type: "TELEGRAM_PREPARE", status: "FAILED" }, select: { id: true, lastError: true }, orderBy: { updatedAt: "desc" }, take: 5 });
  return <WorkspaceShell user={user} active="ai-drafts">
    <div className="flex flex-wrap justify-between gap-4"><h1>AI Drafts</h1><Link className="button" href="/workspace/ai-settings">AI settings</Link></div>
    <p className="muted">Review and edit PostgreSQL AI drafts. Approve records a review decision only; nothing is sent to Telegram.</p>
    {failures.length > 0 && <section className="card p-6 space-y-3"><h2>Preparation failures</h2>{failures.map(job => <p key={job.id}>{job.id}: {job.lastError}</p>)}</section>}
    {drafts.length === 0 && <section className="card p-6">No AI drafts on this page. Enable AI settings and run the Telegram preparation worker to process eligible new posts.</section>}
    {drafts.slice(0, 20).map(draft => <article className="card p-6 space-y-5" key={draft.id}>
      <h2>@{draft.originalPost.sourceChannel.username}</h2>
      <p className="muted">{draft.reviewStatus.replaceAll("_", " ")} · {draft.model} · Settings revision {draft.settingsRevision} · Received {draft.originalPost.receivedAt.toISOString()}</p>
      <div className="grid md:grid-cols-2 gap-6"><section><h3>Original text</h3><p dir="auto" className="text-content">{draft.originalPost.originalText}</p></section><section><h3>AI rewrite</h3><p dir="auto" className="text-content">{draft.aiText}</p></section></div>
      <AiDraftEditor key={`${draft.id}-${draft.editRevision}`} draft={draft} />
    </article>)}
    <nav aria-label="Draft pages" className="flex gap-3">{page > 1 && <Link className="button" href={`?page=${page - 1}`}>Previous</Link>}{drafts.length > 20 && <Link className="button" href={`?page=${page + 1}`}>Next</Link>}</nav>
  </WorkspaceShell>;
}
