/**
 * Owner doc metrics page.
 * Route: `/doc/:docId/metrics`
 *
 * `?shareId=<slug>` scopes every figure on the page to one link of this document; without it the
 * page covers the document, all of its links together. The links table links straight here.
 */
import { Suspense } from "react";

import MetricsPageClient, { MetricsHeaderPlaceholder } from "./pageClient";

/**
 * Render the DocMetricsPage UI.
 *
 * The Suspense boundary is required, not decorative: the client reads the selected link from
 * `useSearchParams`, and Next refuses to prerender a component that does so outside one.
 *
 * Its fallback is the header band, not `null`. Falling back to nothing meant a navigation into this
 * route could blank the whole row — name, star, version, the action buttons — for a beat before the
 * client mounted, so walking in from the document looked like leaving it.
 */
export default async function DocMetricsPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  return (
    <Suspense fallback={<MetricsHeaderPlaceholder docId={docId} />}>
      <MetricsPageClient docId={docId} />
    </Suspense>
  );
}
