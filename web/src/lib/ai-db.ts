import type { Prisma } from "../generated/prisma/client";

// Lock access and settings rows while making a decision. Revocation and settings
// updates serialize with draft commits; no network call occurs while locked.
export async function lockAiAccess(tx: Prisma.TransactionClient, workspaceId: string) {
  await tx.$queryRaw`SELECT u.id FROM "user" u JOIN workspace w ON w."ownerId" = u.id WHERE w.id = ${workspaceId} FOR UPDATE OF u`;
  await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${workspaceId} FOR UPDATE`;
  await tx.$queryRaw`SELECT "workspaceId" FROM workspace_ai_settings WHERE "workspaceId" = ${workspaceId} FOR UPDATE`;
  return tx.workspace.findUnique({
    where: { id: workspaceId },
    include: { owner: true, aiSettings: true },
  });
}

export function hasAiAccess(workspace: Awaited<ReturnType<typeof lockAiAccess>>) {
  return Boolean(workspace?.automationEnabled && workspace.owner.emailVerified &&
    workspace.owner.approvalStatus === "APPROVED");
}
