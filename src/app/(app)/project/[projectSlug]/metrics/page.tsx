/**
 * Owner project metrics page.
 * Route: `/project/:projectId/metrics`
 *
 * `?shareId=<slug>` scopes every figure on the page to one link of this project; without it the
 * page covers the project, all of its links together. The links table links straight here.
 */
import { Suspense } from "react";

import MetricsPageClient from "./pageClient";

/**
 * Render the ProjectMetricsPage UI.
 *
 * The Suspense boundary is required, not decorative: the client reads the selected link from
 * `useSearchParams`, and Next refuses to prerender a component that does so outside one.
 */
export default async function ProjectMetricsPage({ params }: { params: Promise<{ projectSlug: string }> }) {
  const { projectSlug } = await params;
  return (
    <Suspense fallback={null}>
      <MetricsPageClient projectId={projectSlug} />
    </Suspense>
  );
}
