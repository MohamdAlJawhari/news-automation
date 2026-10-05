"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";

export default function RefreshButton({
  children,
}: {
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className="button"
      disabled={pending}
      onClick={() => startTransition(() => router.refresh())}
    >
      {pending ? "Refreshing…" : children}
    </button>
  );
}
