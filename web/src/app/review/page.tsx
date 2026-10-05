import Link from "next/link";
import { db } from "@/lib/db";
import { isAutoPublishEnabled } from "@/lib/settings";
import { requireAdminAccess } from "@/lib/admin";
import { WorkspaceShell } from "@/components/WorkspaceUI";
import DraftEditor from "@/components/DraftEditor";
import PublishButton from "@/components/PublishButton";
import PublicationRecovery from "@/components/PublicationRecovery";
import AutoPublishSwitch from "@/components/AutoPublishSwitch";
import RefreshButton from "@/components/RefreshButton";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
type Draft = {
  id: number;
  original_text: string;
  ai_text: string;
  final_text: string;
  status: string;
  created_at: string;
  destination_message_id: number | null;
  last_error: string | null;
};

export default async function ReviewPage() {
  const access = await requireAdminAccess();
  const drafts = db
    .prepare(
      `
      SELECT
          id,
          original_text,
          ai_text,
          final_text,
          status,
          created_at,
          destination_message_id,
          last_error
      FROM drafts
      ORDER BY id DESC
      LIMIT 50
    `,
    )
    .all() as Draft[];

  return (
    <WorkspaceShell user={access.user} active="review">
      <div className="mx-auto max-w-6xl space-y-7">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <p className="eyebrow">REVIEW</p>
            <h1>News Review</h1>
            <p className="muted mt-3">
              Review saved drafts and manage publication.
            </p>
          </div>
          <div className="flex flex-wrap gap-3">
            <Link href="/channels" className="button">
              Legacy source channels
            </Link>
            <RefreshButton>Refresh drafts</RefreshButton>
          </div>
        </header>

        <AutoPublishSwitch initialEnabled={isAutoPublishEnabled()} />

        {drafts.length === 0 ? (
          <p className="card p-8 muted">
            No drafts yet. Send a source post through your workflow.
          </p>
        ) : (
          <div className="space-y-6">
            {drafts.map((draft) => (
              <article key={draft.id} className="overflow-hidden card">
                <header className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 p-5">
                  <div>
                    <h2 className="font-semibold">Draft #{draft.id}</h2>
                    <p className="mt-1 text-sm muted">
                      Saved: {draft.created_at} UTC
                    </p>
                  </div>

                  <span className="status paused capitalize">
                    {draft.status}
                  </span>
                </header>

                <div className="grid gap-6 p-5 md:grid-cols-2">
                  <section className="min-w-0">
                    <h3 className="mb-3 font-semibold muted">Original post</h3>
                    <p dir="auto" className="text-content">
                      {draft.original_text}
                    </p>
                  </section>

                  <section className="min-w-0">
                    <h3 className="mb-3 font-semibold text-blue-600">
                      Saved AI rewrite
                    </h3>
                    <p dir="auto" className="text-content">
                      {draft.ai_text}
                    </p>
                  </section>
                </div>

                {draft.status === "pending" ? (
                  <DraftEditor
                    draftId={draft.id}
                    initialText={draft.final_text}
                  />
                ) : (
                  <section className="border-t border-slate-100 p-5">
                    <h3 className="mb-3 font-semibold text-emerald-700">
                      Saved final text
                    </h3>

                    <p dir="auto" className="text-content">
                      {draft.final_text}
                    </p>
                  </section>
                )}

                <div className="px-5 pb-5">
                  {draft.status === "approved" && (
                    <PublishButton draftId={draft.id} />
                  )}

                  {draft.status === "publishing" && (
                    <div>
                      <p className="text-amber-700">
                        {draft.last_error ||
                          "Publication is in progress or awaiting confirmation. Refresh to check."}
                      </p>

                      <PublicationRecovery draftId={draft.id} />
                    </div>
                  )}

                  {draft.status === "published" &&
                    draft.destination_message_id && (
                      <a
                        href={`https://t.me/news_output_test/${draft.destination_message_id}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-blue-600 underline"
                      >
                        View published message
                      </a>
                    )}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </WorkspaceShell>
  );
}
