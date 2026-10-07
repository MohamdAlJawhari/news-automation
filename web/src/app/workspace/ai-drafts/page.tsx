import { redirect } from "next/navigation";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { prisma } from "@/lib/prisma";
import { ensureDefaultCampaign } from "@/lib/default-campaign";
export default async function DefaultRedirect() {
  const { workspace } = await requireWorkspaceAccess("automation");
  const campaign = await prisma.$transaction(tx => ensureDefaultCampaign(tx, workspace.id));
  redirect(`/workspace/campaigns/${encodeURIComponent(campaign.id)}/drafts`);
}
