"use client";

import { useState } from "react";
import Image from "next/image";
import { fetchJson } from "@/lib/http/fetchJson";

/**
 * Password gate for share pages.
 *
 * Prompts for a share password and calls `/api/share/:shareId/unlock` to set an auth cookie.
 */
export default function PasswordGate({
  shareId,
  title,
  previewUrl,
}: {
  shareId: string;
  title?: string | null;
  previewUrl?: string | null;
}) {
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const previewSrc =
    typeof previewUrl === "string" && (previewUrl.startsWith("/") || /^https?:\/\//i.test(previewUrl))
      ? previewUrl
      : null;

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
    <main className="min-h-screen bg-zinc-950 text-zinc-50">
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-16">
        <div className="mb-8 inline-flex items-center justify-center">
          <Image src="/icon-white.svg?v=3" alt="LinkDrop" width={34} height={34} priority />
        </div>

        <div className="w-full rounded-3xl border border-white/10 bg-white/5 p-6 shadow-sm backdrop-blur">
          <div className="text-base font-semibold text-white">Password required</div>
          <div className="mt-2 text-sm text-white/70">
            {title ? (
              <>
                Enter the password to view <span className="font-semibold text-white/90">{title}</span>.
              </>
            ) : (
              "Enter the password to view this document."
            )}
          </div>

          {previewSrc ? (
            <div className="mt-5 overflow-hidden rounded-2xl border border-white/10 bg-black/20">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewSrc}
                alt={title ? `Preview of ${title}` : "Document preview"}
                className="aspect-[16/9] w-full object-cover"
              />
            </div>
          ) : null}

          <div className="mt-5">
            <label className="text-xs font-medium text-white/75" htmlFor="share-password">
              Password
            </label>
            <input
              id="share-password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                if (!password.trim() || submitting) return;
                void unlock();
              }}
              className="mt-2 h-10 w-full rounded-lg border border-white/10 bg-white/5 px-3 text-sm text-white placeholder:text-white/35 focus:outline-none focus:ring-2 focus:ring-white/15"
              placeholder="Enter password"
              autoComplete="current-password"
              autoFocus
            />
          </div>

          {error ? (
            <div className="mt-4 rounded-xl border border-red-500/20 bg-red-500/10 px-4 py-3 text-sm text-red-100/90">
              {error}
            </div>
          ) : null}

          <div className="mt-5 flex items-center justify-end">
            <button
              type="button"
              onClick={() => void unlock()}
              disabled={!password.trim() || submitting}
              className="inline-flex items-center justify-center rounded-lg bg-white/90 px-4 py-2 text-sm font-semibold text-zinc-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Unlocking…" : "Unlock"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}



