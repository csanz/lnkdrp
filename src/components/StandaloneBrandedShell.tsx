/**
 * Standalone shell for public-ish pages outside the app shell (billing redirects, the root error
 * page): the shared `BrandHeader` over a centered content column. Intentionally minimal so each page
 * controls its own inner layout.
 */
import type { ReactNode } from "react";
import BrandHeader from "@/components/BrandHeader";

export function StandaloneBrandedShell(props: { children: ReactNode }) {
  return (
    <main className="min-h-screen bg-[var(--bg)] text-[var(--fg)]">
      <BrandHeader logoHref="/" />
      <div className="mx-auto w-full max-w-2xl px-6 py-10">{props.children}</div>
    </main>
  );
}
