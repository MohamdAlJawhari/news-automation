"use client";

import { useActionState, useState } from "react";

import { saveRssItem, type RssItemState } from "@/app/actions/rss-items";

type RssItemEditorProps = {
  item: {
    id: string;
    title: string;
    content: string;
    visible: boolean;
    publishedAt: string;
    updatedAt: string;
  };
};

export default function RssItemEditor({ item }: RssItemEditorProps) {
  const title = item.title;
  const [content, setContent] = useState(item.content);
  const [visible, setVisible] = useState(item.visible);
  const [edited, setEdited] = useState(false);

  const initialState: RssItemState = {
    success: false,
    message: "",
    updatedAt: item.updatedAt,
  };

  const [state, formAction, pending] = useActionState(
    saveRssItem,
    initialState,
  );

  const contentId = `rss-content-${item.id}`;
  const visibleId = `rss-visible-${item.id}`;

  return (
    <article className="space-y-4">
      <p className="mb-5 text-sm muted">Source date: {item.publishedAt}</p>

      {edited && (
        <p className="muted text-sm" role="status">
          {state.success &&
          content.trim() === item.content &&
          visible === item.visible
            ? "Changes saved."
            : "Save to apply content and visibility changes."}
        </p>
      )}
      <form action={formAction} className="space-y-5">
        <input type="hidden" name="itemId" value={item.id} />

        <input type="hidden" name="updatedAt" value={state.updatedAt} />

        <fieldset disabled={pending} className="space-y-5">
          <input type="hidden" name="title" value={title} />
          <p className="muted text-sm">
            RSS titles are generated automatically from the first processed
            line. Edit the saved content below; current channel rules, header,
            and footer apply when the feed is read.
          </p>
          <div>
            <label htmlFor={contentId} className="block font-medium">
              RSS content
            </label>

            <textarea
              id={contentId}
              name="content"
              required
              maxLength={20000}
              rows={8}
              dir="auto"
              value={content}
              onChange={(event) => (
                setContent(event.target.value),
                setEdited(true)
              )}
              className="field text-start"
            />
          </div>

          <label htmlFor={visibleId} className="flex items-center gap-3">
            <input
              id={visibleId}
              type="checkbox"
              name="visible"
              checked={visible}
              onChange={(event) => (
                setVisible(event.target.checked),
                setEdited(true)
              )}
            />
            Include in RSS feed
          </label>

          <p className="text-sm muted">
            Uncheck to hide this item. Check again to restore it. Save to apply
            your changes.
          </p>

          <button type="submit" className="button primary">
            {pending ? "Saving…" : "Save item"}
          </button>
        </fieldset>

        <p
          role="status"
          className={
            state.success
              ? "text-sm feedback-success"
              : "text-sm feedback-error"
          }
        >
          {state.message}
        </p>
      </form>
    </article>
  );
}
