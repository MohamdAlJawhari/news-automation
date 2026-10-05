"use client";

import { useActionState, useState } from "react";
import { saveDraft } from "@/app/actions/drafts";

type DraftEditorProps = {
  draftId: number;
  initialText: string;
};

export default function DraftEditor({
  draftId,
  initialText,
}: DraftEditorProps) {
  const [text, setText] = useState(initialText);
  const [editedSinceSubmit, setEditedSinceSubmit] = useState(false);

  const [state, formAction, isPending] = useActionState(saveDraft, {
    success: false,
    message: "",
  });

  const fieldId = `final-text-${draftId}`;

  return (
    <form
      action={formAction}
      onSubmit={() => setEditedSinceSubmit(false)}
      className="space-y-4 border-t border-slate-100 p-5"
    >
      <input type="hidden" name="draftId" value={draftId} />

      <label htmlFor={fieldId} className="block font-semibold feedback-success">
        Final text
      </label>

      <textarea
        id={fieldId}
        name="finalText"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setEditedSinceSubmit(true);
        }}
        dir="auto"
        rows={8}
        required
        maxLength={20000}
        readOnly={isPending}
        className="field text-start"
      />

      <p className="text-sm muted">
        Approving saves your current text. Rejecting keeps the last saved
        version.
      </p>

      <div className="flex flex-wrap items-center gap-4">
        <button
          type="submit"
          name="intent"
          value="save"
          disabled={isPending || !text.trim()}
          className="button"
        >
          {isPending ? "Working…" : "Save changes"}
        </button>

        <button
          type="submit"
          name="intent"
          value="approve"
          disabled={isPending || !text.trim()}
          className="button primary"
        >
          Save &amp; approve
        </button>

        <button
          type="submit"
          name="intent"
          value="reject"
          formNoValidate
          disabled={isPending}
          className="button danger"
        >
          Reject
        </button>

        <p
          aria-live="polite"
          className={
            editedSinceSubmit
              ? "text-sm text-amber-700"
              : state.success
                ? "text-sm feedback-success"
                : "text-sm feedback-error"
          }
        >
          {isPending
            ? ""
            : editedSinceSubmit
              ? "Unsaved changes"
              : state.message}
        </p>
      </div>
    </form>
  );
}
