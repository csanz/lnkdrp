/**
 * Page for `/tag/:slug` — everything carrying one tag.
 *
 * A tag is one idea that lands on two kinds of thing, so the page shows both: the projects first,
 * because a project is a container and a reader scanning "fundraising" wants the data room before
 * the loose documents, then the documents.
 */
import type { Metadata } from "next";

import TagPageClient from "./pageClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Tag" };

export default async function TagPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <TagPageClient slug={decodeURIComponent(slug ?? "")} />;
}
