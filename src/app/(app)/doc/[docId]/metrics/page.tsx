/**
 * Owner doc metrics page.
 * Route: `/doc/:docId/metrics`
 */
import MetricsPageClient from "./pageClient";
/**
 * Render the DocMetricsPage UI.
 */


export default async function DocMetricsPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  return <MetricsPageClient docId={docId} />;
}


