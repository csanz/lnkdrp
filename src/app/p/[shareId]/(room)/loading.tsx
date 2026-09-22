/**
 * Loading state for a project share link.
 * Route: `/p/:shareId` and, through this boundary, `/p/:shareId/:docId`
 *
 * A spinner, not a skeleton. This used to draw six placeholder document cards, which is the room's
 * shape — but the boundary also covers the document route underneath it, so opening a document
 * flashed a grid of fake cards before the viewer appeared, promising a page the reader had just
 * navigated away from. A skeleton is only honest when the thing it outlines is the thing that
 * arrives; here it could not be, so it waits the way `/s/:shareId` waits.
 */
"use client";

import RouteLoadingScreen from "@/components/RouteLoadingScreen";

export default function Loading() {
  return <RouteLoadingScreen dark />;
}
