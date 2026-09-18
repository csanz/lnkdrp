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

import { useMemo } from "react";

import MetricsView, { docMetricsScope } from "@/components/metrics/MetricsView";

/**
 * Render the MetricsPageClient UI.
 */
export default function MetricsPageClient({ docId }: { docId: string }) {
  // Stable across renders: `MetricsView` keeps the scope in a `useMemo` dependency.
  const scope = useMemo(() => docMetricsScope(docId), [docId]);
  return <MetricsView scope={scope} />;
}
