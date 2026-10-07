import { redirect } from "next/navigation";
import { campaignPage } from "@/lib/campaign-page";
export default async function LegacyPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { campaign } = await campaignPage(params);
  redirect(`/workspace/campaigns/${encodeURIComponent(campaign.id)}/drafts`);
}
