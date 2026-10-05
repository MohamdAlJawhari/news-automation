import Link from "next/link";
import { WorkspaceShell } from "@/components/WorkspaceUI";
import SubmitButton from "@/components/SubmitButton";
import { requireAdminAccess } from "@/lib/admin";
import { getChannels } from "@/lib/channels";
import { addChannel, setChannelEnabled } from "@/app/actions/channels";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function ChannelsPage({
  searchParams,
}: {
  searchParams: Promise<{ message?: string | string[] }>;
}) {
  const access = await requireAdminAccess();

  const channels = getChannels();
  const params = await searchParams;
  const message = typeof params.message === "string" ? params.message : "";

  return (
    <WorkspaceShell user={access.user} active="review">
      <div className="mx-auto max-w-4xl space-y-6">
        <Link href="/review" className="back">
          ← Back to News Review
        </Link>

        <h1 className="text-3xl font-bold">Legacy source channels</h1>

        <p className="muted">
          These sources belong to the existing review workflow. Join each source
          using the Telegram account connected to your reader, then add it here.
        </p>

        <form action={addChannel} className="space-y-3 card p-5">
          <label htmlFor="channel" className="block font-medium">
            Public channel username or link
          </label>

          <input
            id="channel"
            name="channel"
            required
            maxLength={200}
            placeholder="@testRssN8n or https://t.me/testRssN8n"
            className="field"
          />

          <SubmitButton pendingLabel="Adding...">Add channel</SubmitButton>
        </form>

        {message && (
          <p role="status" className="text-blue-700">
            {message}
          </p>
        )}

        <p className="text-sm muted">
          Enabled means selected for monitoring. Connection errors appear in the
          reader terminal. Disabling a source does not cancel drafts already
          being processed.
        </p>

        {channels.length === 0 && (
          <p>No sources yet. Add your test channel first.</p>
        )}

        {channels.map((channel) => (
          <article
            key={channel.id}
            className="flex flex-wrap items-center justify-between gap-4 card p-5"
          >
            <div>
              <a
                href={`https://t.me/${channel.username}`}
                target="_blank"
                rel="noopener noreferrer"
                className="font-semibold text-blue-600"
              >
                @{channel.username}
              </a>

              <p className="mt-1 text-sm muted">
                {channel.enabled ? "Enabled" : "Disabled"}
              </p>
            </div>

            <form action={setChannelEnabled}>
              <input type="hidden" name="id" value={channel.id} />
              <input
                type="hidden"
                name="enabled"
                value={channel.enabled ? "0" : "1"}
              />

              <SubmitButton className="button">
                {channel.enabled ? "Disable" : "Enable"}
              </SubmitButton>
            </form>
          </article>
        ))}
      </div>
    </WorkspaceShell>
  );
}
