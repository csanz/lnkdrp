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

import dynamic from "next/dynamic";

import { projectMetricsScope } from "@/components/metrics/MetricsView";

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
  loading: () => <div className="min-h-[100svh] w-full bg-[var(--bg)]" aria-busy="true" />,
});

/**
 * Render the ProjectMetricsPageClient UI.
 */
export default function MetricsPageClient({ projectId }: { projectId: string }) {
  // Stable across renders: `MetricsView` keeps the scope in a `useMemo` dependency.
  const scope = useMemo(() => projectMetricsScope(projectId), [projectId]);
  return <MetricsView scope={scope} />;
}
