import type { SVGProps } from "react";
export type IconName = "campaigns" | "sources" | "users" | "overview" | "drafts" | "settings" | "grid" | "list" | "more" | "plus" | "sort" | "compare" | "close" | "send";
const paths: Record<IconName, string> = {
  campaigns: "M3 7h18v13H3z M7 7V4h10v3",
  sources: "M4 11a9 9 0 0 1 9 9 M4 4a16 16 0 0 1 16 16 M4 19h1v1H4z",
  users: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2 M16 3a4 4 0 0 1 0 8 M22 21v-2a4 4 0 0 0-3-4 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8",
  overview: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  drafts: "M14 2H5v20h14V7z M14 2v6h5 M8 12h8 M8 16h6",
  settings: "M4 7h16 M4 17h16 M8 4v6 M16 14v6",
  grid: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
  list: "M8 5h13 M8 12h13 M8 19h13 M3 5h1 M3 12h1 M3 19h1",
  more: "M5 12h1 M11 12h1 M17 12h1",
  plus: "M12 5v14 M5 12h14",
  sort: "M8 3v18 M4 17l4 4 4-4 M14 5h7 M14 10h5 M14 15h3",
  compare: "M3 4h18v16H3z M12 4v16",
  close: "M6 6l12 12 M18 6 6 18",
  send: "m22 2-7 20-4-9-9-4Z M22 2 11 13",
};
export default function OutlineIcon({ name, ...props }: SVGProps<SVGSVGElement> & { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...props}><path d={paths[name]} /></svg>;
}
