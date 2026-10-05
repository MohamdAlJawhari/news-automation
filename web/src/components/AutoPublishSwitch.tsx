"use client";

import { useActionState } from "react";
import { updateAutoPublish } from "@/app/actions/settings";

export default function AutoPublishSwitch({
  initialEnabled,
}: {
  initialEnabled: boolean;
}) {
  const [state, formAction, isPending] = useActionState(updateAutoPublish, {
    message: "",
  });

  const enabled = state.enabled ?? initialEnabled;

  return (
    <form action={formAction} className="space-y-3 card p-5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="font-semibold">Auto-publish new posts</h2>
          <p className="mt-1 text-sm muted">
            {enabled
              ? "New AI rewrites are published without review."
              : "New drafts wait for your review."}
          </p>
        </div>

        <button
          type="submit"
          role="switch"
          aria-checked={enabled}
          aria-label="Auto-publish new posts"
          name="enabled"
          value={String(!enabled)}
          disabled={isPending}
          className={`button ${enabled ? "primary" : ""}`}
        >
          {isPending ? "Saving…" : enabled ? "ON" : "OFF"}
        </button>
      </div>

      <p className="text-sm muted">
        Existing drafts are unaffected. A publication already underway may
        finish after switching off.
      </p>

      <p aria-live="polite" className="text-sm text-blue-700">
        {state.message}
      </p>
    </form>
  );
}
