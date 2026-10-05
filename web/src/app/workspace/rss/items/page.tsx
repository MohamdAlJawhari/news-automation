import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireSourceManagementAccess } from "@/lib/workspace-access";
import { processRssContent, readReplacementRules } from "@/lib/rss-rules";
import RssItemEditor from "@/components/RssItemEditor";
import {
  WorkspaceShell,
  BackToDashboard,
  ChannelAvatar,
} from "@/components/WorkspaceUI";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const PAGE_SIZE = 20;
function safeUrl(value: string | null) {
  try {
    const url = new URL(value || "");
    return ["https:", "http:"].includes(url.protocol) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}
export default async function RssItemsPage({
  searchParams,
}: {
  searchParams: Promise<{
    source?: string | string[];
    page?: string | string[];
    view?: string | string[];
  }>;
}) {
  const { user, workspace } = await requireSourceManagementAccess();
  const params = await searchParams;
  if (typeof params.source !== "string" || !params.source)
    redirect("/workspace/sources");
  const source = await prisma.sourceChannel.findFirst({
    where: { id: params.source, workspaceId: workspace.id },
    select: {
      id: true,
      username: true,
      title: true,
      rssFeed: {
        select: {
          headerText: true,
          footerText: true,
          removeKeywords: true,
          replaceRules: true,
          enabled: true,
          tokenHash: true,
        },
      },
    },
  });
  if (!source) notFound();
  const processedView = params.view === "processed" && workspace.rssEnabled;
  const requestedPage =
    typeof params.page === "string" && /^[1-9]\d{0,8}$/.test(params.page)
      ? Number(params.page)
      : 1;
  const where = { workspaceId: workspace.id, sourceChannelId: source.id };
  const total = await prisma.originalPost.count({ where });
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const page = Math.min(requestedPage, pageCount);
  const posts = await prisma.originalPost.findMany({
    where,
    orderBy: [{ publishedAt: "desc" }, { id: "desc" }],
    skip: (page - 1) * PAGE_SIZE,
    take: PAGE_SIZE,
    select: {
      id: true,
      telegramMessageId: true,
      originalText: true,
      sourceUrl: true,
      publishedAt: true,
      rssItem: {
        select: {
          id: true,
          title: true,
          content: true,
          visible: true,
          updatedAt: true,
          sourceUrl: true,
        },
      },
    },
  });
  const feed = source.rssFeed;
  const href = (view: string, number: number) =>
    `/workspace/rss/items?source=${encodeURIComponent(source.id)}&view=${view}&page=${number}`;
  const view = processedView ? "processed" : "original";
  return (
    <WorkspaceShell user={user} active="channels">
      <BackToDashboard />
      <header className="card p-7 flex flex-wrap items-center gap-5">
        <ChannelAvatar name={source.title || source.username} />
        <div className="min-w-0">
          <p className="eyebrow">CHANNEL POSTS</p>
          <h1 className="break-all">@{source.username}</h1>
          <p className="muted mt-3">
            Browse the latest content collected from this Telegram channel.
          </p>
        </div>
        {workspace.rssEnabled && (
          <Link
            href={`/workspace/rss?source=${encodeURIComponent(source.id)}`}
            className="button sm:ml-auto"
          >
            Settings
          </Link>
        )}
      </header>
      <section className="card p-6 flex flex-wrap justify-between items-center gap-5">
        <div>
          <h3>Content view</h3>
          <p className="muted text-sm mt-2">
            {processedView
              ? "Saved RSS content with the channel’s current saved rules."
              : "The original message received from Telegram."}
          </p>
        </div>
        {workspace.rssEnabled ? (
          <nav
            aria-label="Content view"
            className="flex gap-1 rounded-xl border border-slate-200 bg-slate-50 p-1"
          >
            <Link
              href={href("original", page)}
              aria-current={!processedView ? "page" : undefined}
              className={`button ${!processedView ? "primary" : "!border-transparent !bg-transparent"}`}
            >
              Original
            </Link>
            <Link
              href={href("processed", page)}
              aria-current={processedView ? "page" : undefined}
              className={`button ${processedView ? "primary" : "!border-transparent !bg-transparent"}`}
            >
              Processed
            </Link>
          </nav>
        ) : (
          <p className="muted text-sm">RSS processing access is not granted.</p>
        )}
      </section>
      {processedView && (
        <p className="muted text-sm">
          RSS titles are generated automatically from the first processed line.
          Hidden items can be previewed here but are excluded from the feed.{" "}
          {!feed?.enabled || !feed?.tokenHash
            ? "This feed is currently unavailable: enable it and create an access link in Settings."
            : ""}
        </p>
      )}
      <div className="space-y-6">
        {posts.map((post) => {
          let content = post.originalText;
          let empty = content ? "" : "This original post has no text.";
          let generatedTitle = "";
          if (processedView) {
            if (!post.rssItem) {
              content = "";
              empty =
                "No RSS item exists yet. The RSS worker has not prepared this post.";
            } else if (!feed) {
              content = "";
              empty = "No RSS settings are available for this post.";
            } else
              try {
                const result = processRssContent(post.rssItem.content, {
                  ...feed,
                  replaceRules: readReplacementRules(feed.replaceRules),
                });
                content = result?.content || "";
                generatedTitle = result?.title || "";
                empty = result
                  ? ""
                  : "The current rules produce empty content. This post is omitted from the RSS feed.";
              } catch {
                content = "";
                empty =
                  "Processing failed. Review the channel’s saved rules and content limits.";
              }
          }
          const url = safeUrl(
            processedView && post.rssItem
              ? post.rssItem.sourceUrl
              : post.sourceUrl,
          );
          return (
            <article key={post.id} className="card overflow-hidden">
              <header className="p-6 flex flex-wrap justify-between items-center gap-4 border-b border-slate-100">
                <div className="flex gap-4 items-center">
                  <div className="avatar" aria-hidden="true">
                    ≡
                  </div>
                  <div>
                    <h3>Text post</h3>
                    <p className="muted text-sm mt-1">
                      Message #{post.telegramMessageId}
                      {processedView && post.rssItem && !post.rssItem.visible
                        ? " · Hidden from RSS"
                        : ""}
                    </p>
                  </div>
                </div>
                <time
                  className="muted text-sm"
                  dateTime={post.publishedAt.toISOString()}
                >
                  {post.publishedAt.toUTCString()}
                </time>
              </header>
              <div className="p-6 sm:p-7">
                {generatedTitle && (
                  <div className="mb-5">
                    <p className="muted text-xs mb-2">
                      Automatically generated RSS title
                    </p>
                    <p dir="auto" className="text-content font-semibold">
                      {generatedTitle}
                    </p>
                  </div>
                )}
                {empty ? (
                  <p role="status" className="muted">
                    {empty}
                  </p>
                ) : (
                  <p dir="auto" className="text-content">
                    {content}
                  </p>
                )}
              </div>
              <footer className="bg-[#f9fbfe] p-6 border-t border-slate-100 flex flex-wrap justify-between gap-4">
                <span className="muted text-sm">Telegram message</span>
                {url ? (
                  <a
                    href={url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-semibold text-blue-600"
                  >
                    Open source ↗
                  </a>
                ) : (
                  <span className="muted text-sm">Source link unavailable</span>
                )}
              </footer>
              {workspace.rssEnabled && post.rssItem && (
                <details className="border-t border-slate-100 p-6">
                  <summary className="cursor-pointer text-blue-600 font-semibold">
                    Edit saved content / Hide or restore
                  </summary>
                  <div className="mt-5">
                    <RssItemEditor
                      key={post.rssItem.id}
                      item={{
                        ...post.rssItem,
                        publishedAt: post.publishedAt.toUTCString(),
                        updatedAt: post.rssItem.updatedAt.toISOString(),
                      }}
                    />
                  </div>
                </details>
              )}
            </article>
          );
        })}
      </div>
      {!posts.length && (
        <p className="card p-8 muted">
          No posts collected yet. The reader must be connected to this channel
          to collect new posts.
        </p>
      )}
      <nav
        aria-label="Post pages"
        className="flex flex-wrap items-center justify-between gap-4"
      >
        {page > 1 ? (
          <Link href={href(view, page - 1)} className="button">
            ← Previous
          </Link>
        ) : (
          <span />
        )}
        <p className="muted text-sm">
          Page {page} of {pageCount}
        </p>
        {page < pageCount ? (
          <Link href={href(view, page + 1)} className="button">
            Next →
          </Link>
        ) : (
          <span />
        )}
      </nav>
    </WorkspaceShell>
  );
}
