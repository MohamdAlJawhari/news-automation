import { notFound, redirect } from "next/navigation";
import { prisma } from "@/lib/prisma";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import RssSettings from "@/components/RssSettings";
import { readReplacementRules } from "@/lib/rss-rules";
import { WorkspaceShell, BackToDashboard } from "@/components/WorkspaceUI";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function WorkspaceRssPage({
  searchParams,
}: {
  searchParams: Promise<{ source?: string | string[] }>;
}) {
  const { user, workspace } = await requireWorkspaceAccess("rss");
  const params = await searchParams;
  if (typeof params.source !== "string" || !params.source)
    redirect("/workspace/sources");
  const source = await prisma.sourceChannel.findFirst({
    where: { id: params.source, workspaceId: workspace.id },
    select: {
      id: true,
      username: true,
      rssFeed: {
        select: {
          title: true,
          description: true,
          headerText: true,
          footerText: true,
          enabled: true,
          tokenHash: true,
          removeKeywords: true,
          replaceRules: true,
        },
      },
    },
  });
  if (!source) notFound();
  const feed = source.rssFeed;
  return (
    <WorkspaceShell user={user} active="channels">
      <BackToDashboard />
      <header className="pb-2">
        <h1>Channel Settings</h1>
        <p className="muted mt-3">
          Settings for:{" "}
          <span className="text-blue-600 font-semibold">
            @{source.username}
          </span>
        </p>
      </header>
      <RssSettings
        key={source.id}
        sourceId={source.id}
        hasLink={Boolean(feed?.tokenHash)}
        initial={{
          title: feed?.title ?? `@${source.username} — News`,
          description:
            feed?.description ?? "Latest news from this source channel.",
          headerText: feed?.headerText ?? "",
          footerText: feed?.footerText ?? "",
          enabled: feed?.enabled ?? false,
          removeKeywords: feed?.removeKeywords ?? [],
          replaceRules: readReplacementRules(feed?.replaceRules ?? []),
        }}
      />
    </WorkspaceShell>
  );
}
