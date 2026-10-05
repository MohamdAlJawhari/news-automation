import "server-only";

import { headers } from "next/headers";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/prisma";

export async function getCurrentAccess() {
  const session = await auth.api.getSession({
    headers: await headers(),
  });

  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      emailVerified: true,
      platformRole: true,
      approvalStatus: true,
      workspace: {
        select: {
          id: true,
          name: true,
          rssEnabled: true,
          automationEnabled: true,
        },
      },
    },
  });

  if (!user) return null;

  const isApprovedOwner =
    user.emailVerified &&
    user.platformRole === "OWNER" &&
    user.approvalStatus === "APPROVED";

  return {
    session,
    user,
    isApprovedOwner,
  };
}
export type CurrentAccess = NonNullable<
  Awaited<ReturnType<typeof getCurrentAccess>>
>;

export function getEntryDestination(access: CurrentAccess | null) {
  if (!access) return "/login";
  const { user } = access;
  if (
    user.emailVerified &&
    user.approvalStatus === "APPROVED" &&
    user.workspace &&
    (user.workspace.rssEnabled || user.workspace.automationEnabled)
  ) {
    return "/workspace/sources";
  }
  return "/account-status";
}
