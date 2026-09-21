/**
 * Loading state for one document opened inside a project link.
 * Route: `/p/:shareId/:docId`
 *
 * Without this file the segment inherits `/p/:shareId/loading.tsx`, which is the ROOM's skeleton —
 * a grid of document cards. Opening a document then flashed a grid of placeholder cards before the
 * viewer appeared, promising the wrong page. A document opened here is the same experience as
 * `/s/:shareId`, so it waits the same way: the shared route spinner on the share page's dark
 * ground, and nothing that pretends to be content.
 */
"use client";

import RouteLoadingScreen from "@/components/RouteLoadingScreen";

export default function Loading() {
  return <RouteLoadingScreen dark />;
}
