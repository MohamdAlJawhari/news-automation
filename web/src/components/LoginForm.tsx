"use client";

import { useState } from "react";
import { authClient } from "@/lib/auth-client";

export default function LoginForm() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleGoogleLogin() {
    setLoading(true);
    setError("");

    try {
      const result = await authClient.signIn.social({
        provider: "google",
        callbackURL: "/",
      });

      if (result.error) {
        setError(result.error.message || "Could not sign in.");
        setLoading(false);
      }
    } catch {
      setError("Could not connect. Please try again.");
      setLoading(false);
    }
  }

  return (
    <main className="workspace-ui login-shell">
      <div className="card w-full max-w-md p-7 sm:p-9">
        <h1 className="text-center !text-3xl">Telegram Feed Platform</h1>

        <p className="mt-3 text-center muted">Sign in to continue</p>

        <button
          type="button"
          onClick={handleGoogleLogin}
          disabled={loading}
          className="button primary mt-8 w-full"
        >
          {loading ? "Connecting…" : "Continue with Google"}
        </button>

        {error && (
          <p role="alert" className="mt-4 text-sm feedback-error">
            {error}
          </p>
        )}
      </div>
    </main>
  );
}
