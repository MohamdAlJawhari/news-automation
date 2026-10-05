"use client";

import { useActionState, useState } from "react";
import { recoverPublication } from "@/app/actions/recover-publication";

export default function PublicationRecovery({ draftId }: { draftId: number }) {
  const [outcome, setOutcome] = useState("published");

  const [state, formAction, isPending] = useActionState(recoverPublication, {
    success: false,
    message: "",
  });

  return (
    <details className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-4">
      <summary className="cursor-pointer font-semibold text-amber-700">
        Resolve uncertain publication
      </summary>

      <form action={formAction} className="mt-4 space-y-4">
        <input type="hidden" name="draftId" value={draftId} />

        <fieldset disabled={isPending} className="space-y-4">
          <p className="text-sm muted">
            Check News Output Test and the matching n8n execution. Any execution
            for this draft must have finished or been stopped. Do not rerun it.
          </p>

          <label className="block space-y-2">
            <span>Confirmed outcome</span>

            <select
              name="outcome"
              value={outcome}
              onChange={(event) => setOutcome(event.target.value)}
              className="field"
            >
              <option value="published">The exact final text was posted</option>

              <option value="not-sent">No message was posted</option>
            </select>
          </label>

          {outcome === "published" && (
            <label className="block space-y-2">
              <span>Published message link</span>

              <input
                name="messageLink"
                type="url"
                required
                placeholder="https://t.me/news_output_test/123"
                className="field"
              />
            </label>
          )}

          <label className="flex items-start gap-3 text-sm">
            <input
              key={outcome}
              type="checkbox"
              name="checked"
              required
              className="mt-1"
            />

            <span>
              I checked the destination and confirmed this outcome. No execution
              for this draft is running, waiting, queued, or scheduled to retry.
            </span>
          </label>

          <button type="submit" className="button primary">
            {isPending
              ? "Updating…"
              : outcome === "published"
                ? "Record existing publication"
                : "Return to approved"}
          </button>
        </fieldset>

        <p
          aria-live="polite"
          className={state.success ? "feedback-success" : "feedback-error"}
        >
          {state.message}
        </p>
      </form>
    </details>
  );
}
