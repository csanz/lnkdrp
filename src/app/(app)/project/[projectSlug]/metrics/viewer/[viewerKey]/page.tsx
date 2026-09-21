/**
 * Page for `/project/:projectSlug/metrics/viewer/:viewerKey` — one reader of one project.
 */
import type { Metadata } from "next";

import ViewerPageClient from "./pageClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Reader" };

export default async function ProjectViewerPage({
  params,
}: {
  params: Promise<{ projectSlug: string; viewerKey: string }>;
}) {
  const { projectSlug, viewerKey } = await params;
  return <ViewerPageClient projectId={projectSlug} viewerKey={viewerKey} />;
}
