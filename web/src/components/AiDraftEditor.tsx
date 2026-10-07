"use client";
import { useActionState, useState } from "react";
import { useUnsavedChanges } from "./useUnsavedChanges";
import { saveAiDraft, saveCampaignAiDraft } from "@/app/actions/ai";
import { DirectPublishButton } from "./DirectPublishingControls";
import OutlineIcon from "./OutlineIcon";

export default function AiDraftEditor({ draft, locked = false, published = false, campaignId, publishingUnavailable }: { draft: { id: string; finalText: string; editRevision: number; reviewStatus: string }; locked?: boolean; published?: boolean; campaignId?: string; publishingUnavailable?: string }) {
  const [text, setText] = useState(draft.finalText);
  const [saved, setSaved] = useState(draft.finalText);
  const [revision, setRevision] = useState(draft.editRevision);
  const [review, setReview] = useState(draft.reviewStatus);
  const [state, action, pending] = useActionState(async (previous: { success: boolean; message: string; revision: number }, form: FormData) => {
    const result = await (campaignId ? saveCampaignAiDraft : saveAiDraft)(previous, form);
    if (result.success) {
      setRevision(result.revision);
      const intent = form.get("intent");
      if (intent === "save") { const value = String(form.get("finalText")).trim(); setText(value); setSaved(value); }
      setReview(intent === "approve" ? "APPROVED" : intent === "reject" ? "REJECTED" : "PENDING_REVIEW");
    }
    return result;
  }, { success: false, message: "", revision: draft.editRevision });
  const dirty = text !== saved;
  const stale = draft.editRevision !== revision;
  useUnsavedChanges(dirty);
  return <div className="space-y-4"><form action={action} data-unsaved={dirty} className="space-y-4">
    {campaignId && <input type="hidden" name="campaignId" value={campaignId} />}
    <input type="hidden" name="draftId" value={draft.id} /><input type="hidden" name="revision" value={revision} />
    <fieldset disabled={pending} className="space-y-4">
      <label htmlFor={`final-${draft.id}`}>Final text · AI prepared</label><textarea id={`final-${draft.id}`} name="finalText" value={text} readOnly={locked} onChange={event => setText(event.target.value)} required maxLength={20000} rows={published ? 3 : 8} dir="auto" className={`field ${published ? "published-text" : ""}`} />
      {dirty && <p className="muted text-sm">Save your edits before approving or rejecting.</p>}
      {!locked && <div className="draft-actions"><button className="button draft-reject icon-button" name="intent" value="reject" disabled={dirty} aria-label="Reject draft" title="Reject draft"><OutlineIcon name="close" /></button>
        <div className="draft-actions-primary"><button className="button draft-save" name="intent" value="save">Save draft</button><button className="button primary draft-approve" name="intent" value="approve" disabled={dirty}><OutlineIcon name="send" />Approve</button></div>
      </div>}
    </fieldset>
    <p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
  </form>
    {locked && <p className="muted">{published ? "Published drafts are read-only." : "This draft is locked by its publication. Resolve delivery before changing text or review."}</p>}
    {stale && <><p className="feedback-error">A newer draft revision is available. Copy unsaved text, then load the latest version before publishing.</p><button type="button" className="button" onClick={() => { if (dirty && !window.confirm("Discard your unsaved edits and load the latest saved draft?")) return; setText(draft.finalText); setSaved(draft.finalText); setReview(draft.reviewStatus); setRevision(draft.editRevision); }}>Load latest saved draft</button></>}
    {review === "APPROVED" && !locked && <DirectPublishButton campaignId={campaignId} id={draft.id} revision={revision} disabled={dirty || pending || stale || Boolean(publishingUnavailable)} />}
    {publishingUnavailable && !published && <p className="muted" role="status">{publishingUnavailable}</p>}
  </div>;
}
