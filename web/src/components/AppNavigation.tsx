import Link from "next/link";
import SignOutButton from "@/components/SignOutButton";
import type { CurrentAccess } from "@/lib/access";
export type NavigationSection = "channels" | "review" | "users" | "ai-drafts" | "ai-settings" | "publishing";
export default function AppNavigation({
  user,
  active,
}: {
  user: CurrentAccess["user"];
  active?: NavigationSection;
}) {
  const owner =
    user.emailVerified &&
    user.approvalStatus === "APPROVED" &&
    user.platformRole === "OWNER";
  const links = [
    { key: "channels", label: "Channels", href: "/workspace/sources" },
    ...(user.emailVerified && user.approvalStatus === "APPROVED" && user.workspace?.automationEnabled
      ? [
          { key: "ai-drafts", label: "AI Drafts", href: "/workspace/ai-drafts" },
          { key: "ai-settings", label: "AI settings", href: "/workspace/ai-settings" },
          { key: "publishing", label: "Publishing", href: "/workspace/publishing" },
        ] : []),
    ...(owner
      ? [
          { key: "review", label: "News Review", href: "/review" },
          { key: "users", label: "Users", href: "/users" },
        ]
      : []),
  ];
  return (
    <header className="topbar card">
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
            {link.label}
          </Link>
        ))}
      </nav>
      <div className="topbar-account">
        <span className="muted account-identity" title={user.email}>
          {user.email}
        </span>
        <SignOutButton />
      </div>
    </header>
  );
}
