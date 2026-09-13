import { notFound } from "next/navigation";
import DocReviewPageClient from "./pageClient";

/** AI review is not released at launch; the page only exists when the requests flag is on. */
const FEATURE_REQUESTS_ENABLED = process.env.NEXT_PUBLIC_FEATURE_REQUESTS === "1";

/**
 * Render the DocReviewPage UI.
 */
export default async function DocReviewPage(props: { params: Promise<{ docId: string }> }) {
  if (!FEATURE_REQUESTS_ENABLED) notFound();
  const { docId } = await props.params;
  return <DocReviewPageClient docId={docId} />;
}
