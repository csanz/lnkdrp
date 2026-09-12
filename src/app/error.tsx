"use client";

/**
 * Root route error boundary (App Router `error.tsx`).
 *
 * Catches render/data errors thrown below the root layout and shows a minimal branded
 * fallback instead of Next's default unstyled error screen. `reset()` re-renders the segment.
 */
import { useEffect } from "react";
import Link from "next/link";
import { StandaloneBrandedShell } from "@/components/StandaloneBrandedShell";
import { debugError } from "@/lib/debug";

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    debugError(1, "[app] route error", { message: error?.message, digest: error?.digest });
  }, [error]);

  return (
    <StandaloneBrandedShell kicker="Error">
      <div className="rounded-2xl bg-[var(--panel)] p-8">
        <div className="text-[20px] font-semibold tracking-tight text-[var(--fg)]">Something went wrong</div>
        <div className="mt-2 text-[13px] leading-6 text-[var(--muted-2)]">
          This page hit an unexpected error. You can try again, or head back to your dashboard.
        </div>
        {error?.digest ? (
          <div className="mt-3 text-[11px] text-[var(--muted-2)]">
            Reference: <span className="font-mono">{error.digest}</span>
          </div>
        ) : null}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)]"
          >
            Try again
          </button>
          <Link
            className="rounded-xl border border-[var(--border)] px-4 py-2 text-[13px] font-semibold text-[var(--fg)]"
            href="/dashboard"
          >
            Go to dashboard
          </Link>
        </div>
      </div>
    </StandaloneBrandedShell>
  );
}
