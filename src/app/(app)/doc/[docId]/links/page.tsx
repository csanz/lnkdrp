/**
 * Owner doc links page.
 * Route: `/doc/:docId/links`
 */
import LinksPageClient from "./pageClient";
/**
 * Render the DocLinksPage UI.
 */


export default async function DocLinksPage({ params }: { params: Promise<{ docId: string }> }) {
  const { docId } = await params;
  return <LinksPageClient docId={docId} />;
}
