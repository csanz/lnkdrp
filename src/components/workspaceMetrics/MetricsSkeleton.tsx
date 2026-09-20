"use client";

/**
 * The `/metrics` loading skeleton and the state a workspace sees before it has shared anything.
 *
 * The skeleton mirrors the final layout block for block — four tiles, a chart card of the same
 * height, then the two-column grid of ranked sections — so the first paint and the loaded page are
 * the same shape and nothing jumps when the numbers arrive.
 */
import Link from "next/link";
import { ArrowUpTrayIcon } from "@heroicons/react/24/outline";

/** Placeholder in the shape of the loaded page, so nothing moves when the data lands. */
export default function MetricsSkeleton() {
  return (
    <div className="grid gap-6" aria-hidden="true">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div
            key={i}
            className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 motion-safe:animate-pulse"
            style={{ animationDelay: `${i * 80}ms` }}
          >
            <div className="h-3 w-20 rounded bg-[var(--panel-hover)]" />
            <div className="mt-2 h-8 w-16 rounded bg-[var(--panel-hover)]" />
            <div className="mt-2 h-3 w-24 rounded bg-[var(--panel-hover)]" />
          </div>
        ))}
      </div>

      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
        <div className="h-3.5 w-28 rounded bg-[var(--panel-hover)]" />
        <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="h-56 w-full rounded-lg bg-[var(--panel-hover)] motion-safe:animate-pulse" />
          <div className="mt-3 h-4 w-full" />
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {Array.from({ length: 4 }).map((_, s) => (
          <div key={s} className="min-w-0">
            <div className="mb-2 h-3 w-24 rounded bg-[var(--panel-hover)]" />
            <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
              <ul className="divide-y divide-[var(--border)]">
                {Array.from({ length: 4 }).map((_, i) => (
                  <li key={i} className="flex items-center gap-3 px-4 py-3 motion-safe:animate-pulse" style={{ animationDelay: `${i * 80}ms` }}>
                    <div className="min-w-0 flex-1">
                      <div className="h-3.5 w-[min(320px,70%)] rounded bg-[var(--panel-hover)]" />
                      <div className="mt-2 h-3 w-24 rounded bg-[var(--panel-hover)]" />
                    </div>
                    <div className="h-4 w-10 shrink-0 rounded bg-[var(--panel-hover)]" />
                  </li>
                ))}
              </ul>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * Nothing shared yet: say what the page will show rather than drawing four zeros, and give the one
 * action that starts producing numbers.
 */
export function MetricsEmptyWorkspace() {
  return (
    <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-6 py-12 text-center">
      <h2 className="text-[15px] font-semibold text-[var(--fg)]">No shared documents yet</h2>
      <p className="mx-auto mt-2 max-w-md text-[13px] leading-5 text-[var(--muted)]">
        Once you share a document, this page shows how many people opened it, how long they read, which
        links are working and which have gone quiet — across the whole workspace.
      </p>
      <Link
        href="/upload"
        className="mt-5 inline-flex items-center gap-2 rounded-xl bg-[var(--fg)] px-4 py-2 text-[13px] font-semibold text-[var(--bg)] transition-opacity hover:opacity-90 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]"
      >
        <ArrowUpTrayIcon className="h-4 w-4" aria-hidden="true" />
        Share a document
      </Link>
    </div>
  );
}
