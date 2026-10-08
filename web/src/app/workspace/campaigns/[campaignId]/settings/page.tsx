import { CampaignShell } from "@/components/CampaignUI";
import { campaignPage } from "@/lib/campaign-page";
import AiSettingsEditor from "@/components/AiSettingsEditor";
import { connectedWorkspace, LOCAL_MODELS } from "@/lib/ai-config";
import { PublishingSettingsEditor } from "@/components/DirectPublishingControls";
import AutoSendControl from "@/components/AutoSendControl";
import HelpButton from "@/components/HelpButton";
export default async function SettingsPage({ params }: { params: Promise<{ campaignId: string }> }) {
    const { user, workspace, campaign, aiSettings, publishingSettings, telegramState } = await campaignPage(params);
    const connected = connectedWorkspace(workspace.id);
    return <CampaignShell campaign={campaign} user={user} active="ai-settings"><h2>Settings</h2>
        {!connected && <p role="status" className="feedback-error">This workspace has no connected Telegram reader. Execution is available only for the configured ingestion workspace.</p>}
        <section className="card p-6 space-y-5">
            <div className="flex items-center gap-2">
                <h2>Telegram delivery</h2>
                <HelpButton label="Telegram delivery requirements">Delivery requires approved automation access, a monitored participating source, enabled publishing and a verified destination. Manage sources and destination in Overview. Manual publishing and automatic delivery use the same protected queue and recovery.</HelpButton>
            </div>
            {!publishingSettings.destinationUsername && <p className="feedback-error">Configure a destination in Overview before enabling delivery.</p>}
            {(!publishingSettings.verifiedAt || publishingSettings.verificationPending) && <p className="feedback-error">Auto-send requires a verified destination. Check Overview.</p>}
            {!aiSettings.enabled && <p className="muted">AI preparation is off. Enable it before enabling Auto-send.</p>}
            <PublishingSettingsEditor campaignId={campaign.id} connected={connected} settings={publishingSettings} mode="delivery" />
            <AutoSendControl campaignId={campaign.id} enabled={campaign.autoSendEnabled} revision={campaign.autoSendRevision} destinationRevision={publishingSettings.revision} destinationChatId={publishingSettings.destinationChatId} destinationUsername={publishingSettings.destinationUsername} />
            {telegramState.floodWaitUntil && telegramState.floodWaitUntil > new Date() && <p role="status">Telegram flood wait until {telegramState.floodWaitUntil.toISOString()}.</p>}
        </section>
        
        <section className="card p-6 space-y-5">
            <h2>AI preparation</h2>
            <AiSettingsEditor key={campaign.id} campaignId={campaign.id} settings={aiSettings} models={LOCAL_MODELS} connected={connected} />
        </section>
        
    </CampaignShell>;
}
