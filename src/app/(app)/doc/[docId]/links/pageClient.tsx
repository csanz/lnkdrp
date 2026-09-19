/**
 * Client component for the owner doc links page.
 * Route: `/doc/:docId/links`
 *
 * The doc side panel only summarises the links; this page is where they are managed. The shell is
 * the document's own header band (`SubPageHeader`) with a "Document › Links" breadcrumb and the
 * same Links/Metrics/… controls the document page carries, so the two sub-pages of a document feel
 * like one place — and like the document itself.
 */
"use client";

import { useEffect, useRef, useState } from "react";
import { LinkIcon, PlusIcon } from "@heroicons/react/24/outline";

import LinksManager, { type LinksManagerHandle } from "@/components/links/LinksManager";
import { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import SubPageHeader from "@/components/SubPageHeader";
import DocIdentityRow from "@/components/doc/DocIdentityRow";
import DocHeaderActions from "@/components/doc/DocHeaderActions";
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
      {/* The document's own header band, unchanged in height, gutter and title line: a sub-page
          should still feel like the document you opened. The breadcrumb takes the place of the
          document's file facts, and the first crumb is the way back. */}
      <SubPageHeader
        kind="doc"
        hideTile
        title={<DocIdentityRow docId={docId} fallbackTitle={docTitle} />}
        crumbs={[{ label: "Document", href: `/doc/${encodeURIComponent(docId)}` }, { label: "Links" }]}
        actions={<DocHeaderActions docId={docId} current="links" />}
      />

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className={`w-full py-6 ${APP_PAGE_GUTTER}`}>
          <div className="mb-5 flex items-start justify-between gap-4">
            <div className="min-w-0">
              <div className="flex items-center gap-2 text-base font-semibold text-[var(--fg)]">
                <LinkIcon className="h-[18px] w-[18px] text-[var(--muted-2)]" aria-hidden="true" />
                <span>Links</span>
              </div>
              <div className="mt-1 text-sm text-[var(--muted)]">
                One link per audience, each with its own settings and its own stats. Labels are private
                to you — recipients never see them.
              </div>
            </div>
            {/* Above the table, not in the header row: a button only this page has would push the
                header's three controls out of the place they hold on the document page. */}
            <button
              type="button"
              onClick={() => managerRef.current?.openCreate()}
              className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--primary-bg)] px-3 text-[13px] font-semibold text-[var(--primary-fg)] shadow-sm transition-colors hover:bg-[var(--primary-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-ring)] focus:ring-offset-2 focus:ring-offset-[var(--panel)]"
            >
              <PlusIcon className="h-4 w-4" aria-hidden="true" />
              New link
            </button>
          </div>

          <LinksManager ref={managerRef} scope={{ kind: "doc", id: docId }} variant="page" />
        </div>
      </div>
    </div>
  );
}
