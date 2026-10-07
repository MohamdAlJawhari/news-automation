"use client";
import { useEffect, useId, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import OutlineIcon, { type IconName } from "./OutlineIcon";
import { confirmUnsavedNavigation } from "./useUnsavedChanges";

export default function CampaignToolbar({ path, search, sort, view, label, displays }: {
  path: string; search: string; sort: "newest" | "oldest"; view: string; label: string;
  displays: readonly { value: string; label: string; icon: IconName }[];
}) {
  const router = useRouter();
  const inputId = useId();
  const field = useRef<HTMLInputElement>(null);
  const committedSearch = useRef(search);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [pending, startTransition] = useTransition();
  function cancelTimer() { if (timer.current) clearTimeout(timer.current); timer.current = null; }
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  useEffect(() => {
    if (field.current && (document.activeElement !== field.current || field.current.value === committedSearch.current)) field.current.value = search;
    committedSearch.current = search;
  }, [search]);
  function navigate(nextSort = sort, nextView = view) {
    cancelTimer();
    const q = field.current?.value.trim() ?? search;
    if (q === search && nextSort === sort && nextView === view) return;
    if (!confirmUnsavedNavigation()) return;
    const query = new URLSearchParams({ q, sort: nextSort, view: nextView });
    startTransition(() => router.replace(`${path}?${query}`, { scroll: false }));
  }
  return <div className="toolbar campaign-toolbar" aria-busy={pending}>
    <form className="toolbar-search" role="search" onSubmit={event => { event.preventDefault(); navigate(); }}>
      <div className="search-label"><label htmlFor={inputId}>{label}</label><span role="status" className="muted search-progress">{pending ? "Updating…" : ""}</span></div>
      <input id={inputId} ref={field} name="q" className="field" type="search" dir="auto" defaultValue={search} maxLength={200}
        onChange={() => { cancelTimer(); timer.current = setTimeout(() => navigate(), 400); }} />
    </form>
    <div className="toolbar-controls">
      <button type="button" className="button sort-control" title={`Sort: ${sort === "newest" ? "newest" : "oldest"} first. Switch order`} onClick={() => navigate(sort === "newest" ? "oldest" : "newest")}>
        <OutlineIcon name="sort" className={sort === "oldest" ? "sort-ascending" : undefined} />{sort === "newest" ? "Newest first" : "Oldest first"}
      </button>
      <div className="display-controls" role="group" aria-label="Display">{displays.map(display => <button key={display.value} type="button"
        className={`button icon-button ${view === display.value ? "selected" : ""}`} aria-label={display.label} title={display.label} aria-pressed={view === display.value}
        onClick={() => navigate(sort, display.value)}><OutlineIcon name={display.icon} /></button>)}</div>
    </div>
  </div>;
}
