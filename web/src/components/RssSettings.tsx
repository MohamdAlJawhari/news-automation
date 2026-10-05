"use client";
import { useActionState, useEffect, useState } from "react";
import {
  manageRssLink,
  saveRssSettings,
  type RssLinkState,
  type RssSettingsState,
} from "@/app/actions/rss";
import RssRulesEditor from "@/components/RssRulesEditor";
import type { ReplacementRule } from "@/lib/rss-rules";
type Settings = {
  title: string;
  description: string;
  headerText: string;
  footerText: string;
  enabled: boolean;
  removeKeywords: string[];
  replaceRules: ReplacementRule[];
};
export default function RssSettings({
  sourceId,
  initial,
  hasLink,
}: {
  sourceId: string;
  initial: Settings;
  hasLink: boolean;
}) {
  const [settings, setSettings] = useState(initial);
  const [hasDraftRules, setHasDraftRules] = useState(false);
  const [state, action, saving] = useActionState(saveRssSettings, {
    message: "",
  } as RssSettingsState);
  const [link, linkAction, changingLink] = useActionState(manageRssLink, {
    message: "",
  } as RssLinkState);
  const [clipboard, setClipboard] = useState({ url: "", message: "" });
  const snapshot = JSON.stringify({
    ...settings,
    title: settings.title.trim(),
    description: settings.description.trim(),
    headerText: settings.headerText.trim(),
    footerText: settings.footerText.trim(),
  });
  const dirty =
    hasDraftRules || snapshot !== (state.saved || JSON.stringify(initial));
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  async function copy() {
    const url = link.feedUrl!;
    try {
      await navigator.clipboard.writeText(url);
      setClipboard({ url, message: "RSS link copied." });
    } catch {
      setClipboard({
        url,
        message:
          "Clipboard failed. Select the displayed link and copy it manually.",
      });
    }
  }
  return (
    <div className="settings-grid">
      <div className="space-y-6">
        <form action={action} className="space-y-6">
          <input type="hidden" name="sourceId" value={sourceId} />
          <fieldset disabled={saving} className="space-y-6">
            <section className="card p-6 space-y-5">
              <h2>Feed settings</h2>
              <label className="block">
                Feed title
                <input
                  className="field"
                  name="title"
                  dir="auto"
                  required
                  maxLength={200}
                  value={settings.title}
                  onChange={(e) =>
                    setSettings({ ...settings, title: e.target.value })
                  }
                />
              </label>
              <label className="block">
                Feed description
                <textarea
                  aria-label="Feed description"
                  className="field"
                  name="description"
                  dir="auto"
                  rows={2}
                  maxLength={2000}
                  value={settings.description}
                  onChange={(e) =>
                    setSettings({ ...settings, description: e.target.value })
                  }
                />
              </label>
              <label className="flex items-center gap-3">
                <input
                  name="enabled"
                  type="checkbox"
                  checked={settings.enabled}
                  onChange={(e) =>
                    setSettings({ ...settings, enabled: e.target.checked })
                  }
                />
                Enable RSS feed
              </label>
              <p className="muted text-sm">
                RSS availability requires an enabled feed and an access link.
                Source monitoring is managed on the dashboard.
              </p>
            </section>
            <section className="card p-6 space-y-5">
              {(["headerText", "footerText"] as const).map((field) => (
                <label key={field} className="block">
                  {field === "headerText" ? "Header" : "Footer"}
                  <textarea
                    aria-label={field === "headerText" ? "Header" : "Footer"}
                    className="field"
                    name={field}
                    dir="auto"
                    rows={3}
                    maxLength={2000}
                    value={settings[field]}
                    onChange={(e) =>
                      setSettings({ ...settings, [field]: e.target.value })
                    }
                  />
                </label>
              ))}
            </section>
            <RssRulesEditor
              removeKeywords={settings.removeKeywords}
              replaceRules={settings.replaceRules}
              onRemoveChange={(rules) =>
                setSettings({ ...settings, removeKeywords: rules })
              }
              onReplaceChange={(rules) =>
                setSettings({ ...settings, replaceRules: rules })
              }
              onDraftChange={setHasDraftRules}
            />
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="submit"
                disabled={hasDraftRules}
                className="button primary"
              >
                {saving ? "Saving…" : "Save Settings"}
              </button>
              <span className="muted text-sm" role="status">
                {saving
                  ? "Saving your settings…"
                  : hasDraftRules
                    ? "Add or clear the draft rules before saving."
                    : dirty
                      ? "You have unsaved changes."
                      : "All settings are saved."}
              </span>
            </div>
          </fieldset>
          {state.message && (
            <p
              role={state.success ? "status" : "alert"}
              className={state.success ? "feedback-success" : "feedback-error"}
            >
              {state.message}
            </p>
          )}
        </form>
        <section id="rss-link" className="card p-6 space-y-4">
          <h2>RSS access link</h2>
          <p className="muted text-sm">
            {hasLink
              ? "An access link exists. Its original text cannot be recovered; replace it only if needed."
              : "Create a link to access this channel’s feed."}{" "}
            Anyone with the link can read the enabled feed.
          </p>
          <form action={linkAction} className="flex flex-wrap gap-3">
            <input type="hidden" name="sourceId" value={sourceId} />
            <button
              name="intent"
              value="rotate"
              disabled={changingLink}
              className="button primary"
            >
              {changingLink
                ? "Updating link…"
                : hasLink
                  ? "Replace link"
                  : "Create link"}
            </button>
            <button
              name="intent"
              value="revoke"
              disabled={changingLink || !hasLink}
              className="button delete-link"
              title="Delete RSS access link"
            >
              Delete link
            </button>
          </form>
          <div className="space-y-2">
            <label htmlFor={`rss-link-${sourceId}`}>RSS link</label>
            <div className="rss-link-row">
              <input
                id={`rss-link-${sourceId}`}
                className="field"
                readOnly
                dir="ltr"
                value={link.feedUrl ?? ""}
                placeholder={
                  hasLink
                    ? "Replace link to display a new RSS URL"
                    : "Create a link to display its URL"
                }
                onFocus={(e) => e.currentTarget.select()}
              />
              {link.feedUrl && (
                <button
                  type="button"
                  className="button primary"
                  aria-label="Copy RSS link"
                  title="Copy to clipboard"
                  disabled={changingLink}
                  onClick={copy}
                >
                  <svg
                    width="22"
                    height="22"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <rect x="8" y="4" width="12" height="16" rx="2" />
                    <path d="M16 4V2H4v16h4M12 8h4M12 12h4" />
                  </svg>
                </button>
              )}
            </div>
            <p role="status" className="text-sm">
              {clipboard.url === link.feedUrl ? clipboard.message : ""}
            </p>
          </div>
          <p className="muted text-sm">
            Replacing a link invalidates the previous link immediately. Link
            changes are separate from Save Settings.
          </p>
          {link.message && (
            <p role="status" className="text-sm">
              {link.message}
            </p>
          )}
        </section>
      </div>
      <aside className="card p-6 space-y-6">
        <h2>Help</h2>
        <section className="space-y-3">
          <h3 className="text-blue-600">Remove keywords</h3>
          <p className="muted leading-7">
            Add one keyword or phrase at a time. Matching is case-sensitive and
            uses whole words or complete phrases, including Arabic text.
          </p>
          <p className="muted leading-7">
            <code>BREAKING</code>, <code>Breaking</code>, and{" "}
            <code>breaking</code> are different. Removing <code>news</code> does
            not remove <code>newsletter</code>.
          </p>
        </section>
        <section className="border-t border-slate-100 pt-6 space-y-3">
          <h3 className="text-blue-600">Replace words</h3>
          <p className="muted leading-7">
            Enter Find and Replacement text, then click Add. Matching is
            case-sensitive and whole-word. Rules execute from top to bottom;
            later rules can match earlier replacements.
          </p>
          <p className="chip text-sm">USA → United States</p>
          <p className="muted text-sm">
            Use the arrows to change execution order. Up to 50 rules per list,
            200 characters per field.
          </p>
        </section>
        <section className="border-t border-slate-100 pt-6 space-y-3">
          <h3 className="text-blue-600">Processing order</h3>
          <p className="muted leading-7">Remove → Replace → Header → Footer</p>
          <p className="muted leading-7">
            Saved rules apply to existing and future RSS items on the next feed
            request. Empty processed content is omitted. RSS item titles are
            generated automatically from the first processed line, before the
            header and footer.
          </p>
        </section>
      </aside>
    </div>
  );
}
