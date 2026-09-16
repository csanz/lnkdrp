"use client";

import { useState } from "react";
import BrandHeader from "@/components/BrandHeader";
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
    // Always dark, like the viewer this gate stands in front of: unlocking swaps the card for the
    // document under the same header, so the page shouldn't also flip from light to black.
    <main
      className="min-h-screen bg-[var(--bg)] text-[var(--fg)]"
      style={
        {
          colorScheme: "dark",
          "--bg": "#000",
          "--fg": "#e7e7ea",
          "--panel": "#111113",
          "--panel-2": "#151518",
          "--border": "#2a2a31",
          "--muted": "#b3b3bb",
          "--muted-2": "#8b8b96",
          "--ring": "rgba(255,255,255,0.25)",
          "--primary-bg": "#fff",
          "--primary-fg": "#000",
          "--primary-hover-bg": "rgba(255,255,255,0.9)",
        } as React.CSSProperties
      }
    >
      <BrandHeader />
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-12 sm:py-16">
        <div className="w-full rounded-3xl border border-[var(--border)] bg-[var(--panel)] p-6 shadow-sm">
          <div className="text-base font-semibold text-[var(--fg)]">Password required</div>
          <div className="mt-2 text-sm text-[var(--muted)]">
            {title ? (
              <>
                Enter the password to view <span className="font-semibold text-[var(--fg)]">{title}</span>.
              </>
            ) : (
              "Enter the password to view this document."
            )}
          </div>

          {previewSrc ? (
            <div className="mt-5 w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] p-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewSrc}
                alt={title ? `Preview of ${title}` : "Document preview"}
                className="block h-auto w-full rounded-xl"
              />
            </div>
          ) : null}

          <div className="mt-5">
            <label className="text-xs font-medium text-[var(--muted-2)]" htmlFor="share-password">
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
              className="mt-2 h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 text-sm text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
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
              className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60"
            >
              {submitting ? "Unlocking…" : "Unlock"}
            </button>
          </div>
        </div>
      </div>
    </main>
  );
}



