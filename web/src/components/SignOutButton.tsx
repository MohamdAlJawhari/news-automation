"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function SignOutButton() {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function handleSignOut() {
    setBusy(true);
    setError("");

    try {
      const result = await authClient.signOut();

      if (result.error) {
        throw new Error("Sign-out failed.");
      }

      router.replace("/login");
      router.refresh();
    } catch {
      setError("Could not sign out. Please try again.");
      setBusy(false);
    }
  }

  return (
    <div>
      <button
        type="button"
        onClick={handleSignOut}
        disabled={busy}
        className="button"
      >
        {busy ? "Signing out…" : "Sign out"}
      </button>

      {error && (
        <p role="alert" className="feedback-error text-sm mt-2">
          {error}
        </p>
      )}
    </div>
  );
}
