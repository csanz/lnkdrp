/**
 * Loading state for the public project share page.
 * Route: `/p/:shareId`
 */
"use client";

import Image from "next/image";

export default function Loading() {
  return (
    <main
      className="min-h-screen bg-[var(--bg)] text-[var(--fg)]"
      style={
        {
          colorScheme: "dark",
          ["--bg" as any]: "#0b0b0c",
          ["--fg" as any]: "#e7e7ea",
          ["--panel" as any]: "#111113",
          ["--panel-2" as any]: "#151518",
          ["--panel-hover" as any]: "#1b1b1f",
          ["--border" as any]: "#2a2a31",
          ["--muted" as any]: "#b3b3bb",
          ["--muted-2" as any]: "#8b8b96",
        } as React.CSSProperties
      }
    >
      <header className="sticky top-0 z-20 w-full border-b border-white/10 bg-black/85 text-white/90 backdrop-blur-sm">
        <div className="px-4 py-3 sm:px-6">
          <div className="flex items-center justify-between gap-4">
            {/* Left (match `/s/:shareId` header dimensions, but show only the logo) */}
            <div className="flex min-w-0 items-center gap-3">
              <div aria-hidden="true" className="inline-flex items-center justify-center">
                <Image src="/icon-white.svg?v=3" alt="" width={26} height={26} priority />
              </div>

              {/* Height shim: match `/s/:shareId` header height (includes border + padding from the controls pill). */}
              <div
                aria-hidden="true"
                className="invisible inline-flex items-center rounded-2xl border border-white/10 bg-white/5 p-1.5"
              >
                <div className="h-8 w-px" />
              </div>
            </div>
          </div>
        </div>
      </header>
      <div className="mx-auto w-full max-w-5xl px-6 pb-12 pt-6">
        <div className="h-7 w-48 animate-pulse rounded-lg bg-[var(--panel-2)]" />
        <div className="mt-3 h-4 w-[min(520px,90%)] animate-pulse rounded-lg bg-[var(--panel-2)]" />

        <div className="mt-8 flex items-baseline justify-between gap-3">
          <div className="h-4 w-28 animate-pulse rounded bg-[var(--panel-2)]" />
          <div className="h-3 w-14 animate-pulse rounded bg-[var(--panel-2)]" />
        </div>

        <div className="mt-3 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, idx) => (
            <div key={idx} className="overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
              <div className="aspect-[16/10] w-full animate-pulse bg-[var(--panel-2)]" />
              <div className="px-4 py-4">
                <div className="h-4 w-40 animate-pulse rounded bg-[var(--panel-2)]" />
                <div className="mt-3 h-3 w-[90%] animate-pulse rounded bg-[var(--panel-2)]" />
                <div className="mt-2 h-3 w-[70%] animate-pulse rounded bg-[var(--panel-2)]" />
              </div>
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}


