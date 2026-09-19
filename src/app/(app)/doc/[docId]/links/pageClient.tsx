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

import { useRef } from "react";
import { LinkIcon, PlusIcon } from "@heroicons/react/24/outline";

import LinksManager, { type LinksManagerHandle } from "@/components/links/LinksManager";
import { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import SubPageHeader from "@/components/SubPageHeader";
import EntityCrumbLabel from "@/components/HeaderIdentity";
import DocIdentityRow from "@/components/doc/DocIdentityRow";
import DocHeaderActions from "@/components/doc/DocHeaderActions";

/** Render the document's Links page: the document's own header band over the links table. */
export default function LinksPageClient({ docId }: { docId: string }) {
  const managerRef = useRef<LinksManagerHandle | null>(null);

  return (
    <div className="flex h-full flex-col">
      {/* The document's own header band, unchanged in height, gutter and title line: a sub-page
          should still feel like the document you opened. The breadcrumb takes the place of the
          document's file facts, and the first crumb is the way back. */}
      <SubPageHeader
        kind="doc"
        hideTile
        // The row makes the `?lite=1` read itself, and shares it with the crumb below, so this page
        // no longer runs a second copy of the same fetch to hand a title down.
        title={<DocIdentityRow docId={docId} />}
        crumbs={[
          {
            label: <EntityCrumbLabel kind="doc" id={docId} noun="Document" />,
            href: `/doc/${encodeURIComponent(docId)}`,
          },
          { label: "Links" },
        ]}
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
