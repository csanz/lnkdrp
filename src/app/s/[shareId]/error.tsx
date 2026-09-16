"use client";

/**
 * Error boundary for the public share route (`/s/:shareId`).
 *
 * Recipients are usually anonymous, so keep the fallback calm and self-contained: the same
 * dark branded frame as the viewer / `not-found`, one "Try again" action, and no app links.
 */
import { useEffect } from "react";
import BrandHeader from "@/components/BrandHeader";
import { debugError } from "@/lib/debug";

export default function ShareError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    debugError(1, "[share] route error", { message: error?.message, digest: error?.digest });
  }, [error]);

  return (
    <main className="min-h-screen bg-black text-white" style={{ backgroundColor: "#000", color: "#fff" }}>
      <BrandHeader />
      <div className="mx-auto w-full max-w-3xl px-6 py-10">
        <div className="text-lg font-semibold tracking-tight text-white/90">This document couldn’t be displayed</div>
        <div className="mt-2 text-sm text-white/70">
          Something went wrong while loading this shared document. Please try again in a moment.
        </div>
        {error?.digest ? (
          <div className="mt-3 text-[11px] text-white/50">
            Reference: <span className="font-mono">{error.digest}</span>
          </div>
        ) : null}
        <div className="mt-6">
          <button
            type="button"
            onClick={() => reset()}
            className="rounded-xl bg-white px-4 py-2.5 text-sm font-semibold text-black shadow-sm transition hover:bg-white/90"
          >
            Try again
          </button>
        </div>
      </div>
    </main>
  );
}
