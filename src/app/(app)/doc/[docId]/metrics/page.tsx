/**
 * Owner doc metrics page.
 * Route: `/doc/:docId/metrics`
 *
 * `?shareId=<slug>` scopes every figure on the page to one link of this document; without it the
 * page covers the document, all of its links together. The links table links straight here.
 */
import { Suspense } from "react";

import MetricsPageClient from "./pageClient";

/**
 * Render the DocMetricsPage UI.
 *
 * The Suspense boundary is required, not decorative: the client reads the selected link from
 * `useSearchParams`, and Next refuses to prerender a component that does so outside one.
 */
export default async function DocMetricsPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  return (
    <Suspense fallback={null}>
      <MetricsPageClient docId={docId} />
    </Suspense>
  );
}
