/**
 * Page for `/requests` (authenticated app shell).
 *
 * Lists request repositories (“Received” inboxes) for the active workspace.
 * Requests are not released at launch; the page only exists when the flag is on.
 */
import { notFound } from "next/navigation";
import RequestsPageClient from "./pageClient";

const FEATURE_REQUESTS_ENABLED = process.env.NEXT_PUBLIC_FEATURE_REQUESTS === "1";

/** Render the Requests page, or 404 when requests are not released. */
export default function RequestsPage() {
  if (!FEATURE_REQUESTS_ENABLED) notFound();
  return <RequestsPageClient />;
}
