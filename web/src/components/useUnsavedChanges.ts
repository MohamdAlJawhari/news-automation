"use client";
import { useEffect } from "react";
const dirtyForms = new Set<symbol>();
export function confirmUnsavedNavigation() {
  return !dirtyForms.size || window.confirm("You have unsaved changes. Apply filters and discard them?");
}
const unload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
const navigate = (event: MouseEvent) => {
  const link = event.target instanceof Element ? event.target.closest("a") : null;
  if (!link || event.defaultPrevented || link.target === "_blank" || event.ctrlKey || event.metaKey || event.shiftKey || link.getAttribute("href")?.startsWith("#")) return;
  if (!window.confirm("You have unsaved changes. Leave this page and discard them?")) { event.preventDefault(); event.stopImmediatePropagation(); }
};
const submitSearch = (event: SubmitEvent) => {
  if (!(event.target instanceof HTMLFormElement) || event.target.getAttribute("method")?.toLowerCase() !== "get") return;
  if (!window.confirm("You have unsaved changes. Apply filters and discard them?")) { event.preventDefault(); event.stopImmediatePropagation(); }
};
export function useUnsavedChanges(dirty: boolean) {
  useEffect(() => {
    if (!dirty) return;
    const token = Symbol(); dirtyForms.add(token);
    window.addEventListener("beforeunload", unload); document.addEventListener("click", navigate, true); document.addEventListener("submit", submitSearch, true);
    return () => {
      dirtyForms.delete(token);
      if (!dirtyForms.size) { window.removeEventListener("beforeunload", unload); document.removeEventListener("click", navigate, true); document.removeEventListener("submit", submitSearch, true); }
    };
  }, [dirty]);
}
