import Link from "next/link";
import type { ReactNode } from "react";
import AppNavigation, {
  type NavigationSection,
} from "@/components/AppNavigation";
import type { CurrentAccess } from "@/lib/access";

export function WorkspaceShell({
  children,
  user,
  active,
  campaignNavigation,
}: {
  children: ReactNode;
  user?: CurrentAccess["user"];
  active?: NavigationSection;
  campaignNavigation?: ReactNode;
}) {
  return (
    <main className="workspace-ui">
      <div className={`shell ${user ? "app-layout" : ""}`}>
        {user && <AppNavigation user={user} active={active} campaignNavigation={campaignNavigation} />}
        <div className="app-content space-y-7">{children}</div>
      </div>
    </main>
  );
}
export function BackToDashboard() {
  return (
    <Link href="/workspace/sources" className="back">
      ← Back to dashboard
    </Link>
  );
}
export function ChannelAvatar({ name }: { name: string }) {
  return (
    <div className="avatar" aria-hidden="true">
      {Array.from(name)[0]?.toUpperCase() || "T"}
    </div>
  );
}
