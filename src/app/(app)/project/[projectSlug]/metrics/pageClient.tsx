/**
 * Client component for the owner project metrics page.
 * Route: `/project/:projectId/metrics`
 *
 * The page itself is `MetricsView`, shared with `/doc/:docId/metrics` — same header band, same
 * range picker, same tiles, same charts, same per-link ranking and viewer lists. All this file
 * decides is the scope.
 */
"use client";

import { useMemo } from "react";

import MetricsView, { projectMetricsScope } from "@/components/metrics/MetricsView";

/**
 * Render the ProjectMetricsPageClient UI.
 */
export default function MetricsPageClient({ projectId }: { projectId: string }) {
  // Stable across renders: `MetricsView` keeps the scope in a `useMemo` dependency.
  const scope = useMemo(() => projectMetricsScope(projectId), [projectId]);
  return <MetricsView scope={scope} />;
}
