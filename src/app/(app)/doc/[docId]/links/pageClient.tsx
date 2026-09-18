/**
 * Client component for the owner doc links page.
 * Route: `/doc/:docId/links`
 *
 * The doc side panel only summarises the links; this page is where they are managed. The shell
 * (back arrow, "Document › Links" breadcrumb, header title) mirrors the metrics page so the two
 * sub-pages of a document feel like one place.
 */
"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ArrowLeftIcon, ChartBarIcon, LinkIcon, PlusIcon } from "@heroicons/react/24/outline";

import LinksManager, { type LinksManagerHandle } from "@/components/links/LinksManager";
import ScopeTile from "@/components/ScopeTile";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

/**
 * Render the LinksPageClient UI (uses effects, local state).
 */
export default function LinksPageClient({ docId }: { docId: string }) {
  const [docTitle, setDocTitle] = useState<string>("");
  const managerRef = useRef<LinksManagerHandle | null>(null);

  // The header shows the document title; `lite=1` keeps the read cheap (no extracted text).
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}?lite=1`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as { doc?: { title?: unknown } } | null;
        const t = typeof json?.doc?.title === "string" ? json.doc.title.trim() : "";
        if (!cancelled && t) setDocTitle(t);
      } catch {
        // the header falls back to "Document"
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-4 py-4 sm:px-6">
        <Link
          href={`/doc/${encodeURIComponent(docId)}`}
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          aria-label="Back to document"
          title="Back to document"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Link>

        {/* The tile says what you are inside; the "Links" heading below says what this page shows. */}
        <ScopeTile kind="doc" />

        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-[var(--fg)]">{docTitle || "Document"}</div>
          <div className="mt-0.5 flex items-center gap-2 whitespace-nowrap text-xs text-[var(--muted)]">
            <Link href={`/doc/${encodeURIComponent(docId)}`} className="hover:underline underline-offset-4">
              Document
            </Link>
            <span aria-hidden="true">›</span>
            <span className="font-medium text-[var(--fg)]">Links</span>
          </div>
        </div>

        {/* Every row's own "Analytics" button scopes to that one link; this is the way out of the
            table to the master metrics page that sums across all of them — without it, a reader
            comparing links here had to know that page existed and edit `?shareId=` out of the URL
            themselves to see the combined picture. */}
        <Link
          href={`/doc/${encodeURIComponent(docId)}/metrics`}
          aria-label="Metrics"
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] font-semibold text-[var(--fg)] transition-colors hover:bg-[var(--panel-hover)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
        >
          <ChartBarIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
          <span className="hidden sm:inline">Metrics</span>
        </Link>

        <button
          type="button"
          onClick={() => managerRef.current?.openCreate()}
          className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-bg)] px-3 text-[13px] font-semibold text-[var(--primary-fg)] shadow-sm transition-colors hover:bg-[var(--primary-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-ring)] focus:ring-offset-2 focus:ring-offset-[var(--panel)]"
        >
          <PlusIcon className="h-4 w-4" aria-hidden="true" />
          New link
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className="w-full px-4 py-6 sm:px-6">
          <div className="mb-5">
            <div className="flex items-center gap-2 text-base font-semibold text-[var(--fg)]">
              <LinkIcon className="h-[18px] w-[18px] text-[var(--muted-2)]" aria-hidden="true" />
              <span>Links</span>
            </div>
            <div className="mt-1 text-sm text-[var(--muted)]">
              One link per audience, each with its own settings and its own stats. Labels are private
              to you — recipients never see them.
            </div>
          </div>

          <LinksManager ref={managerRef} scope={{ kind: "doc", id: docId }} variant="page" />
        </div>
      </div>
    </div>
  );
}
