/**
 * Client component for owner doc metrics page.
 * Route: `/doc/:docId/metrics`
 */
"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import DocMetricsModal from "@/components/modals/DocMetricsModal";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
/**
 * Render the MetricsPageClient UI (uses effects, local state).
 */


export default function MetricsPageClient({ docId }: { docId: string }) {
  const [docTitle, setDocTitle] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
/**
 * Load (updates state (setDocTitle); uses fetchWithTempUser, encodeURIComponent, json).
 */

    async function load() {
      try {
        const res = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}`, { cache: "no-store" });
        if (!res.ok) return;
        const json = (await res.json()) as unknown;
        const t =
          json &&
          typeof json === "object" &&
          (json as { doc?: unknown }).doc &&
          typeof (json as { doc: { title?: unknown } }).doc.title === "string"
            ? String((json as { doc: { title: string } }).doc.title).trim()
            : "";
        if (!cancelled) setDocTitle(t);
      } catch {
        // ignore
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-6 py-4">
        <Link
          href={`/doc/${encodeURIComponent(docId)}`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          aria-label="Back to document"
          title="Back to document"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Link>

        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--fg)]">{docTitle || "Document"}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <Link href={`/doc/${encodeURIComponent(docId)}`} className="hover:underline underline-offset-4">
              Document
            </Link>
            <span aria-hidden="true">›</span>
            <span className="font-medium text-[var(--fg)]">Metrics</span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className="mx-auto w-full max-w-[1400px] px-6 py-6">
          <DocMetricsModal embedded docId={docId} />
        </div>
      </div>
    </div>
  );
}


