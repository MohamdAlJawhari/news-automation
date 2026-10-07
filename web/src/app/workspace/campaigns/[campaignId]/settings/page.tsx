import { CampaignShell } from "@/components/CampaignUI";
import { campaignPage } from "@/lib/campaign-page";
import AiSettingsEditor from "@/components/AiSettingsEditor";
import { connectedWorkspace, LOCAL_MODELS } from "@/lib/ai-config";

export default async function AiSettingsPage({ params }: { params: Promise<{ campaignId: string }> }) {
  const { user, workspace, campaign, aiSettings: settings } = await campaignPage(params);
  const connected = connectedWorkspace(workspace.id);
  return <CampaignShell campaign={campaign} user={user} active="ai-settings">
    <div className="flex flex-wrap justify-between gap-4"><h2>AI preparation settings</h2></div>
    <section className="card p-6 space-y-5">
      <p>Prepare new Telegram source posts as drafts for manual review. Approval does not publish anything.</p>
      {!connected && <p role="status" className="feedback-error">This workspace has no connected Telegram reader. AI activation is available only for the ingestion workspace configured by the administrator.</p>}
      <p className="muted">{settings.activatedAt ? `First activated: ${settings.activatedAt.toISOString()}. Pausing and resuming preserves this boundary.` : "First activation starts with posts received afterward. Older pending jobs stay excluded."}</p>
      <AiSettingsEditor key={campaign.id} campaignId={campaign.id} settings={settings} models={LOCAL_MODELS} connected={connected} />
    </section>
  </CampaignShell>;
}
