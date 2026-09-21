/**
 * Client component for the owner project metrics page.
 * Route: `/project/:projectId/metrics`
 *
 * The page itself is `MetricsView`, shared with `/doc/:docId/metrics` — same header band, same
 * range picker, same tiles, same charts, same per-link ranking and viewer lists. All this file
 * decides is the scope.
 */
"use client";

import { createContext, useContext, useMemo } from "react";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";

import ProjectHeaderActions from "@/components/project/ProjectHeaderActions";
import ProjectIdentityRow from "@/components/project/ProjectIdentityRow";
import SubPageHeader from "@/components/SubPageHeader";
import { projectMetricsScope } from "@/components/metrics/MetricsView";
import EntityCrumbLabel, { CrumbSkeleton, EntityHeaderName } from "@/components/HeaderIdentity";

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
  const { projectId } = useContext(MetricsPlaceholderContext);
  return <MetricsHeaderPlaceholder projectId={projectId} />;
}

/**
 * What stands in while there is no view yet — the `next/dynamic` chunk load, and the route's own
 * `Suspense` boundary, which is why this takes its id as a prop and is exported.
 *
 * A blank full-height div used to take the header band with it — the project's name, its tags and
 * its Links/Metrics buttons all vanished and then came back. Drawing the real band instead keeps the
 * band continuous from the project page through the transition: `ProjectIdentityRow` finds the name
 * itself, and `MetricsView` replaces this with the same band in the same place.
 */
export function MetricsHeaderPlaceholder({ projectId }: { projectId: string }) {
  const base = `/project/${encodeURIComponent(projectId)}`;
  /** Same rule as the document twin: one link's metrics is a different band, so branch on it. */
  const shareId = (useSearchParams()?.get("shareId") ?? "").trim();

  return (
    <div className="flex h-full flex-col">
      {shareId ? (
        <SubPageHeader
          kind="link"
          parent="project"
          title={<EntityHeaderName kind="project" id={projectId} />}
          titleHref={base}
          crumbs={[
            { label: <EntityCrumbLabel kind="project" id={projectId} noun="Project" />, href: base },
            { label: "Links", href: `${base}/links` },
            // No label for the link itself yet: naming it takes the analytics payload, and the view
            // that fetches it has not even been downloaded at this point.
            { label: <CrumbSkeleton /> },
          ]}
          actions={<ProjectHeaderActions projectSlug={projectId} current="links" />}
        />
      ) : (
        <SubPageHeader
          kind="project"
          hideTile
          title={<ProjectIdentityRow projectId={projectId} />}
          crumbs={[
            { label: <EntityCrumbLabel kind="project" id={projectId} noun="Project" />, href: base },
            { label: "Metrics" },
          ]}
          actions={<ProjectHeaderActions projectSlug={projectId} current="metrics" />}
        />
      )}
      <div className="min-h-0 flex-1 bg-[var(--bg)]" aria-busy="true" />
    </div>
  );
}

/**
 * The project id, for the placeholder above — `next/dynamic`'s `loading` element takes no props.
 */
const MetricsPlaceholderContext = createContext<{ projectId: string }>({ projectId: "" });

/**
 * Render the ProjectMetricsPageClient UI.
 */
export default function MetricsPageClient({ projectId }: { projectId: string }) {
  // Stable across renders: `MetricsView` keeps the scope in a `useMemo` dependency.
  const scope = useMemo(() => projectMetricsScope(projectId), [projectId]);
  const placeholderValue = useMemo(() => ({ projectId }), [projectId]);
  return (
    <MetricsPlaceholderContext.Provider value={placeholderValue}>
      <MetricsView scope={scope} />
    </MetricsPlaceholderContext.Provider>
  );
}
