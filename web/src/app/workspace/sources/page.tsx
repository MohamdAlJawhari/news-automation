import Link from "next/link";
import { prisma } from "@/lib/prisma";
import { requireSourceManagementAccess } from "@/lib/workspace-access";
import {
  addWorkspaceSource,
  setWorkspaceSourceEnabled,
} from "@/app/actions/sources";
import { WorkspaceShell, ChannelAvatar } from "@/components/WorkspaceUI";
import SubmitButton from "@/components/SubmitButton";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function WorkspaceSourcesPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string | string[]; q?: string | string[] }>;
}) {
  const { user, workspace } = await requireSourceManagementAccess();
  const params = await searchParams;
  const message = typeof params.message === "string" ? params.message : "";
  const q = typeof params.q === "string" ? params.q.slice(0, 200).trim() : "";
  const sources = await prisma.sourceChannel.findMany({
    where: {
      workspaceId: workspace.id,
      ...(q
        ? {
            OR: [
              {
                username: {
                  contains: q.replace(/^@/, ""),
                  mode: "insensitive" as const,
                },
              },
              { title: { contains: q, mode: "insensitive" as const } },
            ],
          }
        : {}),
    },
    select: {
      id: true,
      username: true,
      title: true,
      enabled: true,
      telegramChatId: true,
      rssFeed: { select: { enabled: true, tokenHash: true } },
      originalPosts: {
        where: { workspaceId: workspace.id },
        orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
        take: 1,
        select: { originalText: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });
  return (
    <WorkspaceShell user={user} active="channels">
      <header className="flex flex-wrap items-start justify-between gap-5">
        <div>
          <p className="eyebrow">OVERVIEW</p>
          <h1>Telegram Feed Platform</h1>
          <p className="muted mt-3">
            Manage your channels, feeds, and settings.
          </p>
        </div>
      </header>
      <section className="card grid gap-6 p-6 lg:grid-cols-[2fr_1fr]">
        <form action={addWorkspaceSource}>
          <label htmlFor="channel">Add a channel</label>
          <div className="mt-2 flex flex-wrap gap-2">
            <input
              id="channel"
              name="channel"
              required
              maxLength={200}
              placeholder="@ Telegram username or t.me link"
              className="field flex-1 basis-52 !mt-0"
            />
            <SubmitButton pendingLabel="Adding…">+ Add Channel</SubmitButton>
          </div>
        </form>
        <form action="/workspace/sources">
          <label htmlFor="search">Search channels</label>
          <div className="mt-2 flex gap-2">
            <input
              id="search"
              name="q"
              defaultValue={q}
              maxLength={200}
              placeholder="Search by name or username…"
              className="field !mt-0"
            />
            <SubmitButton className="button" pendingLabel="Searching…">
              Search
            </SubmitButton>
          </div>
        </form>
      </section>
      {message && (
        <p role="status" className="card p-4 text-blue-700">
          {message}
        </p>
      )}
      <section>
        <h2>Your channels</h2>
        <p className="muted mt-2 mb-6">
          View collected posts, manage feed links, or update channel settings.
        </p>
        <div className="grid gap-5 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {sources.map((source) => {
            const settings = `/workspace/rss?source=${encodeURIComponent(source.id)}`;
            return (
              <article
                key={source.id}
                className="card min-w-0 p-6 flex flex-col gap-5"
              >
                <header className="flex items-center gap-3">
                  <ChannelAvatar name={source.title || source.username} />
                  <div className="min-w-0 flex-1">
                    <h3 dir="auto" className="truncate text-start">
                      {source.title || `@${source.username}`}
                    </h3>
                    <a
                      href={`https://t.me/${source.username}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="muted text-sm break-all"
                    >
                      @{source.username}
                    </a>
                  </div>
                </header>
                <p className="text-sm flex flex-wrap items-center gap-2">
                  Source monitoring{" "}
                  <span className={`status ${!source.enabled ? "paused" : ""}`}>
                    {source.enabled
                      ? source.telegramChatId
                        ? "Enabled"
                        : "Awaiting connection"
                      : "Paused"}
                  </span>
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Link
                    href={`/workspace/rss/items?source=${encodeURIComponent(source.id)}`}
                    className="button primary"
                  >
                    View Posts
                  </Link>
                  {workspace.rssEnabled && (
                    <>
                      <Link href={settings} className="button">
                        Settings
                      </Link>
                      <Link
                        href={`${settings}#rss-link`}
                        className="button col-span-2"
                      >
                        {source.rssFeed?.tokenHash
                          ? "Manage link"
                          : "Create link"}
                      </Link>
                    </>
                  )}
                </div>
                <div className="rounded-xl bg-[#f5f8fc] p-4 flex-1">
                  <h4 className="font-semibold text-sm mb-2">Latest post</h4>
                  <p
                    dir="auto"
                    className="text-content muted text-sm line-clamp-3"
                  >
                    {source.originalPosts[0]?.originalText ||
                      "No posts collected yet."}
                  </p>
                </div>
                <footer className="border-t border-slate-100 pt-4 space-y-3">
                  <p className="muted text-sm">
                    RSS feed:{" "}
                    {!workspace.rssEnabled
                      ? "Access not granted"
                      : !source.rssFeed?.enabled
                        ? "Disabled"
                        : source.rssFeed.tokenHash
                          ? "Available via access link"
                          : "Enabled · no access link"}
                  </p>
                  <form action={setWorkspaceSourceEnabled}>
                    <input type="hidden" name="sourceId" value={source.id} />
                    <input
                      type="hidden"
                      name="enabled"
                      value={String(!source.enabled)}
                    />
                    <SubmitButton className="button">
                      {source.enabled
                        ? "Pause monitoring"
                        : "Enable monitoring"}
                    </SubmitButton>
                  </form>
                </footer>
              </article>
            );
          })}
        </div>
        {!sources.length && (
          <div className="card p-8 muted">
            {q
              ? "No channels match your search."
              : "Add your first channel to get started."}
            {q && (
              <Link href="/workspace/sources" className="ml-3 text-blue-600">
                Clear search
              </Link>
            )}
          </div>
        )}
      </section>
    </WorkspaceShell>
  );
}
