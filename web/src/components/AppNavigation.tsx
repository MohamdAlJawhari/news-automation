import Link from "next/link";
import SignOutButton from "@/components/SignOutButton";
import type { CurrentAccess } from "@/lib/access";
import OutlineIcon, { type IconName } from "./OutlineIcon";
export type NavigationSection = "campaigns" | "channels" | "review" | "users" | "ai-drafts" | "ai-settings" | "publishing";
export default function AppNavigation({
  user,
  active,
  campaignNavigation,
}: {
  user: CurrentAccess["user"];
  active?: NavigationSection;
  campaignNavigation?: React.ReactNode;
}) {
  const owner =
    user.emailVerified &&
    user.approvalStatus === "APPROVED" &&
    user.platformRole === "OWNER";
  const eligible = user.emailVerified && user.approvalStatus === "APPROVED";
  const links = [
    ...(eligible && user.workspace?.automationEnabled ? [{ key: "campaigns", label: "Campaigns", href: "/workspace/campaigns" }] : []),
    ...(eligible && (user.workspace?.rssEnabled || user.workspace?.automationEnabled) ? [{ key: "channels", label: "Sources / RSS", href: "/workspace/sources" }] : []),
    ...(owner ? [{ key: "users", label: "Users", href: "/users" }] : []),
  ];
  return (
    <aside className="app-sidebar">
      <Link href="/" className="brand">
        Telegram Feed Platform
      </Link>
      <nav aria-label="Main navigation" className="topbar-links">
        {links.map((link) => (
          <Link
            key={link.key}
            href={link.href}
            aria-current={active === link.key ? "page" : undefined}
          >
            <OutlineIcon name={(link.key === "channels" ? "sources" : link.key) as IconName} />{link.label}
          </Link>
        ))}
      </nav>
      {campaignNavigation}
      <div className="topbar-account">
        <span className="muted account-identity" title={user.email}>
          {user.email}
        </span>
        <SignOutButton />
      </div>
    </aside>
  );
}
