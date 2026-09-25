/**
 * Segment layout for `/s/:shareId` — it exists to make a refused link answer **404**.
 *
 * `loading.tsx` in this segment wraps the page in a Suspense boundary, so Next flushes the shell
 * and commits a `200` before the page body ever runs. The page's own `notFound()` then renders the
 * right screen ("This document is no longer shared") under a status that says the opposite. Every
 * revoked, expired, archived and unknown link answered `200 OK`, which is wrong for the two readers
 * that only look at the status line: a crawler, which indexes the link as a live page, and an agent
 * — and this product's whole premise is that agents drive it.
 *
 * A layout renders *above* its segment's Suspense boundary and is awaited before anything is sent,
 * so a `notFound()` here still reaches the response. The page keeps its own check: this layout is
 * the status, not the authorization, and the page must stay correct on its own.
 *
 * Cost is one extra indexed read per share-page load (the unique `shareId`, then the document with
 * the small share projection). Paid deliberately, for the same resolver rather than a second
 * definition of "servable" that could drift from the one the page uses.
 */
import { notFound } from "next/navigation";

import { resolveShareLinkForPage } from "@/lib/share/links";

export const dynamic = "force-dynamic";

export default async function ShareLayout(props: {
  children: React.ReactNode;
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await props.params;
  if (!shareId) notFound();
  const resolved = await resolveShareLinkForPage(shareId);
  if (!resolved || resolved.refusal) notFound();
  return props.children;
}
