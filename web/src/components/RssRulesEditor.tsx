"use client";
import { useEffect, useState } from "react";
import type { ReplacementRule } from "@/lib/rss-rules";

type Props = {
  removeKeywords: string[];
  replaceRules: ReplacementRule[];
  onRemoveChange: (rules: string[]) => void;
  onReplaceChange: (rules: ReplacementRule[]) => void;
  onDraftChange: (hasDraft: boolean) => void;
};
function move<T>(rules: T[], index: number, direction: number): T[] {
  const next = [...rules];
  [next[index], next[index + direction]] = [
    next[index + direction],
    next[index],
  ];
  return next;
}
export default function RssRulesEditor({
  removeKeywords,
  replaceRules,
  onRemoveChange,
  onReplaceChange,
  onDraftChange,
}: Props) {
  const [keyword, setKeyword] = useState("");
  const [find, setFind] = useState("");
  const [replacement, setReplacement] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    onDraftChange(Boolean(keyword || find || replacement));
  }, [keyword, find, replacement, onDraftChange]);
  const controls = (
    index: number,
    length: number,
    remove: () => void,
    up: () => void,
    down: () => void,
    label: string,
  ) => (
    <span className="rule-controls">
      <button
        type="button"
        className="button"
        aria-label={`Move ${label} up`}
        disabled={index === 0}
        onClick={up}
      >
        ↑
      </button>
      <button
        type="button"
        className="button"
        aria-label={`Move ${label} down`}
        disabled={index === length - 1}
        onClick={down}
      >
        ↓
      </button>
      <button
        type="button"
        className="button"
        aria-label={`Remove ${label}`}
        onClick={remove}
      >
        ×
      </button>
    </span>
  );
  function addRemoval() {
    const value = keyword.trim();
    if (!value || /[\r\n]/.test(value) || value.length > 200)
      return setError(
        "Enter a single keyword or phrase of at most 200 characters.",
      );
    if (removeKeywords.includes(value))
      return setError("This removal keyword already exists.");
    if (removeKeywords.length >= 50)
      return setError("Use at most 50 removal rules.");
    onRemoveChange([...removeKeywords, value]);
    setKeyword("");
    setError("");
  }
  function addReplacement() {
    if (
      !find.trim() ||
      /[\r\n]/.test(find + replacement) ||
      find.trim().length > 200 ||
      replacement.trim().length > 200
    )
      return setError(
        "Enter a Find phrase; both fields must be single-line text of at most 200 characters.",
      );
    if (replaceRules.length >= 50)
      return setError("Use at most 50 replacement rules.");
    onReplaceChange([
      ...replaceRules,
      { find: find.trim(), replace: replacement.trim() },
    ]);
    setFind("");
    setReplacement("");
    setError("");
  }
  return (
    <>
      <input
        type="hidden"
        name="removeKeywords"
        value={removeKeywords.join("\n")}
      />
      <input
        type="hidden"
        name="replaceRules"
        value={JSON.stringify(replaceRules)}
      />
      <section className="card p-6 space-y-5">
        <h2>Remove keywords</h2>
        <div className="rule-entry">
          <input
            aria-label="Removal keyword"
            className="field"
            dir="auto"
            maxLength={200}
            placeholder="Add a keyword"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                addRemoval();
              }
            }}
          />
          <button
            type="button"
            className="button text-blue-600"
            onClick={addRemoval}
          >
            + Add
          </button>
        </div>
        <div className="flex flex-wrap gap-3">
          {removeKeywords.map((rule, i) => (
            <div key={`${i}-${rule}`} className="chip">
              <span dir="auto" className="break-all text-sm">
                {i + 1}. {rule}
              </span>
              {controls(
                i,
                removeKeywords.length,
                () => onRemoveChange(removeKeywords.filter((_, j) => j !== i)),
                () => onRemoveChange(move(removeKeywords, i, -1)),
                () => onRemoveChange(move(removeKeywords, i, 1)),
                `removal rule ${i + 1}`,
              )}
            </div>
          ))}
        </div>
      </section>
      <section className="card p-6 space-y-5">
        <h2>Replace words</h2>
        <div className="rule-entry">
          <label className="flex-1 min-w-0">
            Find
            <input
              className="field"
              dir="auto"
              maxLength={200}
              placeholder="Enter word or phrase"
              value={find}
              onChange={(e) => setFind(e.target.value)}
            />
          </label>
          <span className="muted" aria-hidden="true">
            →
          </span>
          <label className="flex-1 min-w-0">
            Replacement
            <input
              className="field"
              dir="auto"
              maxLength={200}
              placeholder="Replacement (may be empty)"
              value={replacement}
              onChange={(e) => setReplacement(e.target.value)}
            />
          </label>
          <button
            type="button"
            className="button self-end"
            onClick={addReplacement}
          >
            + Add
          </button>
        </div>
        {replaceRules.map((rule, i) => (
          <div key={i} className="rule-row">
            <p className="min-w-0 break-all">
              <span className="muted mr-2">{i + 1}.</span>
              <bdi>{rule.find}</bdi> → <bdi>{rule.replace || "(remove)"}</bdi>
            </p>
            {controls(
              i,
              replaceRules.length,
              () => onReplaceChange(replaceRules.filter((_, j) => j !== i)),
              () => onReplaceChange(move(replaceRules, i, -1)),
              () => onReplaceChange(move(replaceRules, i, 1)),
              `replacement rule ${i + 1}`,
            )}
          </div>
        ))}
        <p className="muted text-sm">
          Rules execute in the displayed order. Click Add to include each draft
          rule before saving.
        </p>
      </section>
      {error && (
        <p role="alert" className="feedback-error">
          {error}
        </p>
      )}
    </>
  );
}
