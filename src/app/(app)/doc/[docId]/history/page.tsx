/**
 * Owner doc history page.
 * Route: `/doc/:docId/history`
 */
import HistoryPageClient from "./pageClient";

/**
 * Render the DocHistoryPage UI.
 */
export default async function DocHistoryPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  return <HistoryPageClient docId={docId} />;
}


