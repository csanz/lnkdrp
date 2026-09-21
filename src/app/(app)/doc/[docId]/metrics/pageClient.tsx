/**
 * Client component for owner doc metrics page.
 * Route: `/doc/:docId/metrics`
 *
 * The page itself is `MetricsView`, which a project's metrics page mounts too — the whole client
 * moved to `src/components/metrics/MetricsView.tsx` when projects needed the same page rather than
 * a second copy of it. What is left here is the scope: which API to read and which breadcrumb to
 * print.
 */
"use client";

import { createContext, useContext, useMemo } from "react";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

import DocHeaderActions from "@/components/doc/DocHeaderActions";
import DocReplaceFileButton from "@/components/doc/DocReplaceFileButton";
import DocIdentityRow from "@/components/doc/DocIdentityRow";
import SubPageHeader from "@/components/SubPageHeader";
import EntityCrumbLabel, { CrumbSkeleton, EntityHeaderName } from "@/components/HeaderIdentity";
import { docMetricsScope } from "@/components/metrics/MetricsView";

/**
 * Client-only on purpose.
 *
 * Every figure on this page comes from fetches the browser makes after mount, so the server
 * has nothing real to render — it can only produce the empty state, which the client then
 * replaces. Worse, this page sits inside a `Suspense` boundary whose effects can run before
 * React hydrates it, so a fast response made the first client render disagree with that empty
 * server markup and hydration failed intermittently. Skipping SSR for a view that cannot be
 * server-rendered usefully removes the whole class of mismatch instead of guarding branch by
 * branch, and costs nothing: the skeleton below is what the server was emitting anyway.
 */
const MetricsView = dynamic(() => import("@/components/metrics/MetricsView"), {
  ssr: false,
  loading: () => <PlaceholderFromContext />,
});

/** `next/dynamic`'s `loading` element takes no props, so the id reaches it through context. */
function PlaceholderFromContext() {
  const { docId } = useContext(MetricsPlaceholderContext);
  return <MetricsHeaderPlaceholder docId={docId} />;
}

/**
 * What stands in while there is no view yet — the `next/dynamic` chunk load, and the route's own
 * `Suspense` boundary, which is why this takes its id as a prop and is exported.
 *
 * It used to be a blank full-height div, which meant the header band — the document's name, its
 * star, its version, the Links/Metrics buttons — disappeared completely and then reappeared.
 * Rendering the real header instead makes that beat invisible: `DocIdentityRow` finds the name
 * itself, so it is already correct here and does not move when `MetricsView` takes over and draws
 * the same band.
 */
export function MetricsHeaderPlaceholder({ docId }: { docId: string }) {
  const base = `/doc/${encodeURIComponent(docId)}`;
  /**
   * `?shareId=` means this page is one *link's* metrics, and `MetricsView` draws a different band
   * for it — a link tile, a three-step breadcrumb and Links as the current action. A placeholder
   * that ignored the parameter replaced a missing header with a *wrong* one: the tile appeared,
   * the breadcrumb grew a step and the filled button jumped from Metrics to Links the moment the
   * view mounted. So the placeholder branches on exactly what the view branches on.
   */
  const shareId = (useSearchParams()?.get("shareId") ?? "").trim();

  return (
    <div className="flex h-full flex-col">
      {shareId ? (
        <SubPageHeader
          kind="link"
          parent="doc"
          title={<EntityHeaderName kind="doc" id={docId} />}
          titleHref={base}
          crumbs={[
            { label: <EntityCrumbLabel kind="doc" id={docId} noun="Document" />, href: base },
            { label: "Links", href: `${base}/links` },
            // No label for the link itself yet: naming it takes the analytics payload, and the view
            // that fetches it has not even been downloaded at this point.
            { label: <CrumbSkeleton /> },
          ]}
          actions={
            <div className="flex items-center gap-2 md:gap-3">
              <DocReplaceFileButton docId={docId} />
              <DocHeaderActions docId={docId} current="links" />
            </div>
          }
        />
      ) : (
        <SubPageHeader
          kind="doc"
          hideTile
          title={<DocIdentityRow docId={docId} />}
          crumbs={[
            { label: <EntityCrumbLabel kind="doc" id={docId} noun="Document" />, href: base },
            { label: "Metrics" },
          ]}
          actions={
            <div className="flex items-center gap-2 md:gap-3">
              <DocReplaceFileButton docId={docId} />
              <DocHeaderActions docId={docId} current="metrics" />
            </div>
          }
        />
      )}
      <div className="min-h-0 flex-1 bg-[var(--bg)]" aria-busy="true" />
    </div>
  );
}

/**
 * The document id, for the placeholder above.
 *
 * `next/dynamic`'s `loading` element takes no props, so the id reaches it through context rather
 * than by lifting the placeholder into the page body (which would render it *beside* the view
 * instead of in place of it).
 */
const MetricsPlaceholderContext = createContext<{ docId: string }>({ docId: "" });

/**
 * Render the MetricsPageClient UI.
 */
export default function MetricsPageClient({ docId }: { docId: string }) {
  // Stable across renders: `MetricsView` keeps the scope in a `useMemo` dependency.
  const scope = useMemo(() => docMetricsScope(docId), [docId]);
  const placeholderValue = useMemo(() => ({ docId }), [docId]);
  return (
    <MetricsPlaceholderContext.Provider value={placeholderValue}>
      <MetricsView scope={scope} />
    </MetricsPlaceholderContext.Provider>
  );
}
