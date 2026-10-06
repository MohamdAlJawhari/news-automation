import Link from "next/link";
import { WorkspaceShell } from "@/components/WorkspaceUI";
import AiSettingsEditor from "@/components/AiSettingsEditor";
import { requireWorkspaceAccess } from "@/lib/workspace-access";
import { prisma } from "@/lib/prisma";
import { lockAiAccess } from "@/lib/ai-db";
import { connectedWorkspace, LOCAL_MODELS } from "@/lib/ai-config";

export default async function AiSettingsPage() {
  const { user, workspace } = await requireWorkspaceAccess("automation");
  const settings = (await prisma.$transaction(tx => lockAiAccess(tx, workspace.id)))!.aiSettings;
  const connected = connectedWorkspace(workspace.id);
  return <WorkspaceShell user={user} active="ai-settings">
    <div className="flex flex-wrap justify-between gap-4"><h1>AI preparation settings</h1><Link className="button" href="/workspace/ai-drafts">AI Drafts</Link></div>
    <section className="card p-6 space-y-5">
      <p>Prepare new Telegram source posts as drafts for manual review. Approval does not publish anything.</p>
      {!connected && <p role="status" className="feedback-error">This workspace has no connected Telegram reader. AI activation is available only for the ingestion workspace configured by the administrator.</p>}
      <p className="muted">{settings.activatedAt ? `First activated: ${settings.activatedAt.toISOString()}. Pausing and resuming preserves this boundary.` : "First activation starts with posts received afterward. Older pending jobs stay excluded."}</p>
      <AiSettingsEditor key={settings.revision} settings={settings} models={LOCAL_MODELS} connected={connected} />
    </section>
  </WorkspaceShell>;
}
