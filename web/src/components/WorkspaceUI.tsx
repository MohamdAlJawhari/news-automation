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
}: {
  children: ReactNode;
  user?: CurrentAccess["user"];
  active?: NavigationSection;
}) {
  return (
    <main className="workspace-ui">
      <div className="shell space-y-7">
        {user && <AppNavigation user={user} active={active} />}
        {children}
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
