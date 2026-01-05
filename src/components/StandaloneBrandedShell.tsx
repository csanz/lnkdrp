/**
 * Standalone branded shell for public-ish pages (e.g. request uploads, billing redirects).
 *
 * Keeps a consistent "LinkDrop" branded frame:
 * - full-height page background
 * - centered content container
 * - small uppercase kicker label (optional)
 *
 * Note: This is intentionally minimal so feature pages can control their own inner layout.
 */
import type { ReactNode } from "react";
import { StandaloneBrandedHeader } from "@/components/StandaloneBrandedHeader";

export function StandaloneBrandedShell(props: { kicker?: string; children: ReactNode }) {
  const kicker = (props.kicker ?? "").trim();
  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <StandaloneBrandedHeader kicker={kicker} />
      <div className="mx-auto w-full max-w-2xl px-6 py-10">{props.children}</div>
    </main>
  );
}


