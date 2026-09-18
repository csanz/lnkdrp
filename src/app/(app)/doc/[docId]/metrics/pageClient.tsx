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

import dynamic from "next/dynamic";

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
  loading: () => <div className="min-h-[100svh] w-full bg-[var(--bg)]" aria-busy="true" />,
});

/**
 * Render the MetricsPageClient UI.
 */
export default function MetricsPageClient({ docId }: { docId: string }) {
  // Stable across renders: `MetricsView` keeps the scope in a `useMemo` dependency.
  const scope = useMemo(() => docMetricsScope(docId), [docId]);
  return <MetricsView scope={scope} />;
}
