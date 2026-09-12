/**
 * Loading state for the public share page.
 * Route: `/s/:shareId`
 *
 * Shown while the server resolves the share (document lookup, password gate) and the viewer
 * bundle loads. Same spinner as the doc-page navigation overlay, on the share page's dark ground.
 */
"use client";

import RouteLoadingScreen from "@/components/RouteLoadingScreen";

export default function Loading() {
  return <RouteLoadingScreen dark />;
}
