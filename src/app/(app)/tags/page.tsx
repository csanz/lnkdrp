/**
 * Page for `/tags` — every tag in the workspace, and what carries it.
 *
 * A page rather than the modal it started as: managing tags is a sit-down job — renaming three
 * near-duplicates, merging two, deciding which of them is really the same idea — and a 520px
 * dialog over the page you were on is the wrong shape for that. The picker that puts tags *on* a
 * document stays a modal, because that one is a ten-second errand.
 */
import type { Metadata } from "next";

import TagsPageClient from "./pageClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Tags" };

export default function TagsPage() {
  return <TagsPageClient />;
}
