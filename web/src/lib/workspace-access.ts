import "server-only";
import { redirect } from "next/navigation";
import { getCurrentAccess, getEntryDestination } from "@/lib/access";

type WorkspaceFeature = "rss" | "automation";
export async function requireWorkspaceAccess(feature?: WorkspaceFeature) {
  const access = await getCurrentAccess();
  if (!access) redirect("/login");
  const workspace = access.user.workspace;
  if (
    !access.user.emailVerified ||
    access.user.approvalStatus !== "APPROVED" ||
    !workspace ||
    (!workspace.rssEnabled && !workspace.automationEnabled)
  ) {
    redirect("/account-status");
  }
  if (
    (feature === "rss" && !workspace.rssEnabled) ||
    (feature === "automation" && !workspace.automationEnabled)
  ) {
    redirect(getEntryDestination(access));
  }
  return { user: access.user, workspace };
}
export async function requireSourceManagementAccess() {
  return requireWorkspaceAccess();
}
