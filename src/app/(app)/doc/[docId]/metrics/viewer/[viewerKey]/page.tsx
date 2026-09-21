/**
 * Page for `/doc/:docId/metrics/viewer/:viewerKey` — one reader of one document.
 *
 * Its own address on purpose: "look at what they actually read" is a thing people send to each
 * other, and a drawer has no link.
 */
import type { Metadata } from "next";

import ViewerPageClient from "./pageClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Reader" };

export default async function DocViewerPage({
  params,
}: {
  params: Promise<{ docId: string; viewerKey: string }>;
}) {
  const { docId, viewerKey } = await params;
  return <ViewerPageClient docId={docId} viewerKey={viewerKey} />;
}
