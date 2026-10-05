import Link from "next/link";
import { redirect } from "next/navigation";
import { getCurrentAccess, getEntryDestination } from "@/lib/access";
import { getAccountStatus } from "@/lib/account-status";
import { WorkspaceShell } from "@/components/WorkspaceUI";
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export default async function AccountStatusPage() {
  const access = await getCurrentAccess();
  if (!access) redirect("/login");
  const destination = getEntryDestination(access);
  if (destination !== "/account-status") redirect(destination);
  const content = getAccountStatus(access.user);
  return (
    <WorkspaceShell user={access.user}>
      <section className="card mx-auto max-w-2xl p-6 sm:p-9 space-y-5">
        <p className="eyebrow">ACCOUNT STATUS</p>
        <h1>{content.title}</h1>
        <p className="muted leading-7">{content.message}</p>
        <Link href="/" className="button primary">
          Check status
        </Link>
      </section>
    </WorkspaceShell>
  );
}
