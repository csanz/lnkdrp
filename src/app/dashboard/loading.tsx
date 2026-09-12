/**
 * Loading state for `/dashboard/*`.
 *
 * Shown by the App Router while the dashboard segment streams in (first load, tab changes,
 * client-side navigation). Reuses the doc-page navigation spinner so the transition feels the same.
 */
"use client";

import RouteLoadingScreen from "@/components/RouteLoadingScreen";

export default function Loading() {
  return <RouteLoadingScreen title="Loading dashboard…" />;
}
