import "server-only";
import { redirect } from "next/navigation";
import { getCurrentAccess, getEntryDestination } from "@/lib/access";

export async function requireAdminAccess() {
  const access = await getCurrentAccess();
  if (!access) redirect("/login");
  if (!access.isApprovedOwner) redirect(getEntryDestination(access));
  return access;
}

export async function requireAdmin() {
  const access = await requireAdminAccess();
  return access.session;
}
