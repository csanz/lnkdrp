/**
 * Client shell for a document reader's page: the document's own header band, then the reader.
 */
"use client";

import { ChartBarIcon, LinkIcon } from "@heroicons/react/24/outline";

import { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import SubPageHeader from "@/components/SubPageHeader";
import DocIdentityRow from "@/components/doc/DocIdentityRow";
import DocHeaderActions from "@/components/doc/DocHeaderActions";
import ViewerProfile from "@/components/metrics/ViewerProfile";

export default function ViewerPageClient({ docId, viewerKey }: { docId: string; viewerKey: string }) {
  const base = `/doc/${encodeURIComponent(docId)}`;
  return (
    <div className="flex h-full flex-col">
      <SubPageHeader
        kind="doc"
        hideTile
        title={<DocIdentityRow docId={docId} />}
        crumbs={[
          { label: "Document", href: base },
          { label: "Metrics", href: `${base}/metrics` },
          { label: "Reader" },
        ]}
        actions={<DocHeaderActions docId={docId} current="metrics" />}
      />

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className={`w-full max-w-5xl py-6 ${APP_PAGE_GUTTER}`}>
          <ViewerProfile scopeKind="doc" scopeId={docId} routeKey={viewerKey} />
        </div>
      </div>
    </div>
  );
}
