"use client";

import { useState, useSyncExternalStore } from "react";
import Image from "next/image";
import Link from "next/link";
import { useTheme } from "next-themes";
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
  const { resolvedTheme } = useTheme();
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Avoid hydration mismatches from client-only theme.
  const mounted = useSyncExternalStore(
    () => () => {
      // no-op subscription
    },
    () => true,
    () => false,
  );
  const logoSrc = mounted && resolvedTheme === "dark" ? "/icon-white.svg?v=3" : "/icon-black.svg?v=3";

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
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto flex w-full max-w-md flex-col items-center px-6 py-16">
        <header className="mb-8 w-full">
          <div className="flex items-center justify-center">
            <Link
              href="/"
              className="inline-flex items-center"
              aria-label="Home"
              title="LinkDrop"
            >
              <Image src={logoSrc} alt="LinkDrop" width={34} height={34} priority />
            </Link>
          </div>
        </header>

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
            <div className="mt-5 h-56 w-full overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel-2)]">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={previewSrc}
                alt={title ? `Preview of ${title}` : "Document preview"}
                className="block h-full w-full object-cover"
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



