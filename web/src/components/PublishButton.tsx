"use client";

import { useActionState } from "react";
import { publishDraft } from "@/app/actions/publish";

export default function PublishButton({ draftId }: { draftId: number }) {
  const [state, formAction, isPending] = useActionState(publishDraft, {
    success: false,
    message: "",
  });

  return (
    <form action={formAction} className="mt-4 space-y-3">
      <input type="hidden" name="draftId" value={draftId} />

      <button type="submit" disabled={isPending} className="button primary">
        {isPending ? "Publishing…" : "Publish to Telegram"}
      </button>

      <p
        aria-live="polite"
        className={state.success ? "feedback-success" : "feedback-error"}
      >
        {state.message}
      </p>
    </form>
  );
}
