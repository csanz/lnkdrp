/**
 * Loading state for `/search`.
 *
 * Shown by the App Router while the search segment streams in (first load, client-side navigation).
 * Reuses the doc-page navigation spinner so the transition feels the same.
 */
"use client";

import RouteLoadingScreen from "@/components/RouteLoadingScreen";

export default function Loading() {
  return <RouteLoadingScreen title="Loading search…" />;
}
