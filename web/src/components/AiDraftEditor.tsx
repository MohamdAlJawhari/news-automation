"use client";
import { useActionState, useState } from "react";
import { saveAiDraft } from "@/app/actions/ai";
import { DirectPublishButton } from "./DirectPublishingControls";

export default function AiDraftEditor({ draft, locked = false }: { draft: { id: string; finalText: string; editRevision: number; reviewStatus: string }; locked?: boolean }) {
  const [state, action, pending] = useActionState(saveAiDraft, { success: false, message: "", revision: draft.editRevision });
  const [text, setText] = useState(draft.finalText);
  const dirty = text !== draft.finalText;
  return <div className="space-y-4"><form action={action} className="space-y-4">
    <input type="hidden" name="id" value={draft.id} /><input type="hidden" name="revision" value={state.revision} />
    <fieldset disabled={pending || locked} className="space-y-4">
      <label htmlFor={`final-${draft.id}`}>Final text</label><textarea id={`final-${draft.id}`} name="finalText" value={text} onChange={event => setText(event.target.value)} required maxLength={20000} rows={8} dir="auto" className="field" />
      {dirty && <p className="muted text-sm">Save your edits before approving or rejecting.</p>}
      <div className="flex flex-wrap gap-3"><button className="button" name="intent" value="save">Save</button><button className="button primary" name="intent" value="approve" disabled={dirty}>Approve</button><button className="button" name="intent" value="reject" disabled={dirty}>Reject</button></div>
    </fieldset>
    <p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
  </form>
    {locked && <p className="muted">This draft is locked by its publication. Resolve delivery before changing text or review.</p>}
    {draft.reviewStatus === "APPROVED" && !locked && <DirectPublishButton id={draft.id} revision={state.revision} disabled={dirty || pending} />}
  </div>;
}
