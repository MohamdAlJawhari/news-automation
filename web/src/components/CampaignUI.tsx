import Link from "next/link";
import type { ReactNode } from "react";
import type { CurrentAccess } from "@/lib/access";
import { WorkspaceShell } from "./WorkspaceUI";
import OutlineIcon from "./OutlineIcon";
export type CampaignTab = "overview" | "drafts" | "settings" | "sources" | "ai-drafts" | "ai-settings" | "publishing";
export function CampaignShell({ campaign, user, active, children }: { campaign: { id: string; name: string; isDefault: boolean }; user: CurrentAccess["user"]; active: CampaignTab; children: ReactNode }) {
  const base = `/workspace/campaigns/${encodeURIComponent(campaign.id)}`;
  const selected = active === "ai-drafts" ? "drafts" : active === "ai-settings" ? "settings" : active === "sources" || active === "publishing" ? "overview" : active;
  return <WorkspaceShell user={user} active="campaigns" campaignNavigation={<div className="campaign-navigation">
    <p dir="auto" className="campaign-name">{campaign.name}</p>
    <nav aria-label="Campaign navigation" className="campaign-tabs">{([
      ["overview", "Overview"], ["drafts", "Drafts"], ["settings", "Settings"],
    ] as const).map(([key, label]) => <Link key={key} href={key === "overview" ? base : `${base}/${key}`} aria-current={selected === key ? "page" : undefined}><OutlineIcon name={key} />{label}</Link>)}</nav>
  </div>}>
    <header className="flex flex-wrap items-center gap-3"><h1 dir="auto" className="break-words min-w-0">{campaign.name}</h1>{campaign.isDefault && <span className="status">Default</span>}</header>{children}
  </WorkspaceShell>;
}
