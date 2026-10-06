import { WorkspaceShell } from "@/components/WorkspaceUI";
import { PublishingSettingsEditor } from "@/components/DirectPublishingControls";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { lockPublishing } from "@/lib/publishing-db";
import { prisma } from "@/lib/prisma";
import { connectedWorkspace } from "@/lib/ai-config";
import RefreshButton from "@/components/RefreshButton";
export default async function PublishingPage() {
  const { user, workspace } = await requireWorkspaceAccess("automation");
  const settings = (await prisma.$transaction(tx => lockPublishing(tx, workspace.id))).settings;
  return <WorkspaceShell user={user} active="publishing">
    <div className="flex justify-between gap-4"><h1>Telegram publishing</h1><RefreshButton>Refresh status</RefreshButton></div>
    <p className="muted">Approved drafts publish as plain text through the existing connected user account. Save and Approve never send messages.</p>
    {!connectedWorkspace(workspace.id) && <p role="status">This workspace has no connected Telegram account. Multi-user login is not available yet.</p>}
    <section className="card p-6 space-y-3"><h2>Destination verification</h2>
      <p>{settings?.verificationPending ? "Pending — keep the connected Telegram reader running, then refresh." : settings?.verifiedAt ? `Verified ${settings.destinationChatId} at ${settings.verifiedAt.toISOString()}` : "Not verified"}</p>
      {settings?.verificationError && <p className="feedback-error">{settings.verificationError}</p>}
    </section>
    <PublishingSettingsEditor key={settings?.updatedAt.toISOString() ?? "initial"} settings={settings ?? { enabled: false, destinationUsername: "", revision: 1 }} />
  </WorkspaceShell>;
}
