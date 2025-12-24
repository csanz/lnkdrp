"use client";

import { useState } from "react";
import { fetchJson } from "@/lib/http/fetchJson";

export default function PasswordGate({ shareId, title }: { shareId: string; title?: string | null }) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function unlock() {
    setSubmitting(true);
    setError(null);
    try {
      await fetchJson(`/api/share/${shareId}/unlock`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
      });
      // Cookie is set by the API; re-render server component with auth.
      window.location.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to unlock");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <main className="min-h-screen bg-white text-zinc-900">
      <div className="mx-auto w-full max-w-md px-6 py-16">
        <div className="rounded-3xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="text-base font-semibold text-zinc-900">Password required</div>
          <div className="mt-2 text-sm text-zinc-600">
            {title ? (
              <>
                Enter the password to view <span className="font-semibold text-zinc-800">{title}</span>.
              </>
            ) : (
              "Enter the password to view this document."
            )}
          </div>

          <div className="mt-5">
            <label className="text-xs font-medium text-zinc-700" htmlFor="share-password">
              Password
            </label>
            <input
              id="share-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (!password.trim() || submitting) return;
                void unlock();
              }}
              className="mt-2 h-10 w-full rounded-lg border border-zinc-200 bg-white px-3 text-sm text-zinc-900 focus:outline-none focus:ring-2 focus:ring-black/10"
              placeholder="Enter password"
              autoComplete="current-password"
              autoFocus
            />
          </div>

          {error ? (
            <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
              {error}
            </div>
          ) : null}

          <div className="mt-5 flex items-center justify-end">
            <button
              type="button"
              onClick={() => void unlock()}
              disabled={!password.trim() || submitting}
              className="inline-flex items-center justify-center rounded-lg bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-800 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Unlocking…" : "Unlock"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}

