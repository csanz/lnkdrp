/**
 * Page for `/requests` (authenticated app shell).
 *
 * Lists request repositories (“Received” inboxes) for the active workspace.
 */
import RequestsPageClient from "./pageClient";

export default function RequestsPage() {
  return <RequestsPageClient />;
}


