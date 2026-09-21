/**
 * Owner project metrics page.
 * Route: `/project/:projectId/metrics`
 *
 * `?shareId=<slug>` scopes every figure on the page to one link of this project; without it the
 * page covers the project, all of its links together. The links table links straight here.
 */
import { Suspense } from "react";

import MetricsPageClient, { MetricsHeaderPlaceholder } from "./pageClient";

/**
 * Render the ProjectMetricsPage UI.
 *
 * The Suspense boundary is required, not decorative: the client reads the selected link from
 * `useSearchParams`, and Next refuses to prerender a component that does so outside one.
 *
 * Its fallback is the header band, not `null`. Falling back to nothing meant a navigation into this
 * route could blank the whole row — name, tags, Links/Metrics buttons — for a beat before the client
 * mounted, so walking in from the project page looked like leaving it. The band is continuous now.
 */
export default async function ProjectMetricsPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  return (
    <Suspense fallback={<MetricsHeaderPlaceholder projectId={projectSlug} />}>
      <MetricsPageClient projectId={projectSlug} />
    </Suspense>
  );
}
