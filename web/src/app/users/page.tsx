import { WorkspaceShell, BackToDashboard } from "@/components/WorkspaceUI";
import SubmitButton from "@/components/SubmitButton";

import { requireAdminAccess } from "@/lib/admin";
import { prisma } from "@/lib/prisma";
import { updateUserAccess } from "@/app/actions/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function UsersPage({
  searchParams,
}: {
  searchParams: Promise<{
    message?: string | string[];
  }>;
}) {
  const access = await requireAdminAccess();

  const params = await searchParams;
  const message = typeof params.message === "string" ? params.message : "";

  const users = await prisma.user.findMany({
    where: {
      platformRole: "USER",
    },
    select: {
      id: true,
      name: true,
      email: true,
      emailVerified: true,
      approvalStatus: true,
      updatedAt: true,
      workspace: {
        select: {
          rssEnabled: true,
          automationEnabled: true,
          updatedAt: true,
        },
      },
    },
    orderBy: {
      createdAt: "desc",
    },
    take: 100,
  });

  return (
    <WorkspaceShell user={access.user} active="users">
      <div className="mx-auto max-w-4xl space-y-6">
        <BackToDashboard />

        <header>
          <h1 className="text-3xl font-bold">Users</h1>

          <p className="mt-2 muted">
            Manage the latest 100 registrations. Owner accounts are excluded.
          </p>
        </header>

        {message && (
          <p role="status" className="card p-4 text-blue-700">
            {message}
          </p>
        )}

        {users.length === 0 && (
          <p className="muted">No user registrations yet.</p>
        )}

        {users.map((user) => (
          <article key={user.id} className="space-y-5 card p-5">
            <div>
              <h2 className="text-lg font-semibold" dir="auto">
                {user.name}
              </h2>

              <p className="break-all muted">{user.email}</p>

              <p className="mt-2 text-sm muted">
                {user.emailVerified ? "Email verified" : "Email not verified"}
                {" · "}
                Current status: {user.approvalStatus}
              </p>
            </div>

            <form
              key={`${user.updatedAt.toISOString()}-${
                user.workspace?.updatedAt.toISOString() ?? ""
              }`}
              action={updateUserAccess}
              className="space-y-4"
            >
              <input type="hidden" name="userId" value={user.id} />

              <div>
                <label
                  htmlFor={`status-${user.id}`}
                  className="mb-2 block font-medium"
                >
                  Account status
                </label>

                <select
                  id={`status-${user.id}`}
                  name="status"
                  defaultValue={user.approvalStatus}
                  className="field"
                >
                  <option value="PENDING">Pending</option>
                  <option value="APPROVED">Approved</option>
                  <option value="REJECTED">Rejected</option>
                  <option value="SUSPENDED">Suspended</option>
                </select>
              </div>

              <fieldset className="space-y-3">
                <legend className="mb-2 font-medium">
                  Features granted when approved
                </legend>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    name="rssEnabled"
                    defaultChecked={user.workspace?.rssEnabled ?? false}
                  />
                  RSS feeds
                </label>

                <label className="flex items-center gap-3">
                  <input
                    type="checkbox"
                    name="automationEnabled"
                    defaultChecked={user.workspace?.automationEnabled ?? false}
                  />
                  Telegram automation
                </label>
              </fieldset>

              <p className="text-sm muted">
                Saving any status other than Approved disables both features.
              </p>

              <SubmitButton>Save access</SubmitButton>
            </form>
          </article>
        ))}
      </div>
    </WorkspaceShell>
  );
}
