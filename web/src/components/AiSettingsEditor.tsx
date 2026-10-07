"use client";
import { useActionState, useState } from "react";
import { useUnsavedChanges } from "./useUnsavedChanges";
import { saveAiSettings, saveCampaignAiSettings } from "@/app/actions/ai";

export default function AiSettingsEditor({ settings, models, connected, campaignId }: {
  settings: { enabled: boolean; systemPrompt: string; editorialPerspective: string; model: string; revision: number };
  models: readonly string[]; connected: boolean; campaignId?: string;
}) {
  const [dirty, setDirty] = useState(false);
  useUnsavedChanges(dirty);
  const [state, action, pending] = useActionState(async (previous: { success: boolean; message: string; revision: number }, form: FormData) => {
    const result = await (campaignId ? saveCampaignAiSettings : saveAiSettings)(previous, form);
    if (result.success) setDirty(false);
    return result;
  }, { success: false, message: "", revision: settings.revision });
  return <form action={action} data-unsaved={dirty} onChange={() => setDirty(true)} className="space-y-5">
    {campaignId && <input type="hidden" name="campaignId" value={campaignId} />}
    <input type="hidden" name="revision" value={state.revision} />
    <fieldset disabled={pending} className="space-y-5">
      <label className="flex gap-3 items-center"><input type="checkbox" name="enabled" defaultChecked={settings.enabled} disabled={!connected} />Enable AI preparation</label>
      <div><label htmlFor="ai-model">Local model</label><select id="ai-model" name="model" defaultValue={settings.model} className="field">{models.map(model => <option key={model}>{model}</option>)}</select></div>
      <div><label htmlFor="ai-perspective">Editorial instructions</label><textarea id="ai-perspective" name="editorialPerspective" defaultValue={settings.editorialPerspective} maxLength={2000} rows={2} dir="auto" className="field" /><p className="muted text-sm">Leave empty for a straightforward news-reporting tone.</p></div>
      <details><summary className="cursor-pointer">Advanced prompt</summary><div className="pt-3"><label htmlFor="ai-system">System prompt</label><textarea id="ai-system" name="systemPrompt" defaultValue={settings.systemPrompt} required maxLength={20000} rows={12} dir="auto" className="field" /></div></details>
      <button className="button primary" type="submit">{pending ? "Saving…" : "Save AI settings"}</button>
    </fieldset>
    {dirty && <p className="muted">Unsaved AI settings.</p>}
    <p role="status" className={state.success ? "feedback-success" : "feedback-error"}>{state.message}</p>
  </form>;
}
