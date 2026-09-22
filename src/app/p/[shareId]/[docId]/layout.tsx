/**
 * Segment layout for `/p/:shareId/:docId`. It is the `[docId]` half of making a document that is
 * not in the room answer **404** instead of `200 OK`.
 *
 * `../layout.tsx` killed the soft-404 for the slug and explains why it had to. This is the same
 * bug one level deeper, and it survived that fix because a layout at `[shareId]` cannot see a
 * `docId`: the membership `notFound()` in `page.tsx` throws inside a Suspense boundary, after the
 * shell has been flushed and the status committed, so `/p/<a live room>/<any id at all>` came back
 * as a live page to the two readers that only look at the status line, crawlers and monitors. That
 * is true for a bogus id and for every document of the workspace that is not in *this* project.
 *
 * A layout renders *above* its own segment's Suspense boundary and is awaited before anything is
 * sent, which is what lets the `notFound()` below reach the response. The page keeps its own check:
 * like the layout above it, this is the status, not the authorization, and the page must stay
 * correct on its own.
 *
 * **What this does not do yet, and what finishes it.** `/p/[shareId]/loading.tsx` opens a boundary
 * that wraps this whole segment, this file included, so today the `notFound()` here is committed
 * just as late as the page's was and the response is still `200`. Measured, not reasoned about:
 * with that one file moved aside, `/p/<room>/<bogus id>` and `/p/<room>/<non-member id>` answer
 * `404` while a member id and the room itself stay `200`. Deleting this segment's own `loading.tsx`
 * changes nothing, for the same reason. What finishes it is scoping the room's boundary to the
 * room: put `/p/[shareId]/page.tsx` and its `loading.tsx` in a `(room)` route group, which changes
 * no URL and keeps the room's spinner, and this file starts answering. That is the room page's move
 * to make, not this segment's, so it is named here rather than taken.
 *
 * The order below is `page.tsx`'s order, deliberately and exactly: **the gate goes up before the
 * room is asked whether it holds the document**. Checking membership first would hand a locked room
 * back its inventory: 404 for an id that is not in it, 200 password gate for one that is, which is
 * the oracle the ordering note in `page.tsx` exists to close. So on the locked path this file asks
 * the room nothing at all, and every candidate id gets the same answer.
 *
 * Not covered, same as the layout above: route handlers are not wrapped by layouts, so
 * `/p/:shareId/:docId/pdf` and `.../preview` go on proving everything themselves. They do, and they
 * must: they are the ones handing over bytes.
 *
 * Cost is one extra indexed read per document open (the slug, then the membership filter), and only
 * on the unlocked path. Paid through the same resolvers the page uses, rather than a second
 * definition of "in this room" that could drift from theirs.
 */
import { cookies } from "next/headers";
import { notFound } from "next/navigation";

import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { findProjectDocument, projectLinkPasswordEnabled } from "@/lib/share/projectPublic";

export const dynamic = "force-dynamic";

export default async function ProjectShareDocumentLayout(props: {
  children: React.ReactNode;
  params: Promise<{ shareId: string; docId: string }>;
}) {
  const { shareId, docId } = await props.params;
  if (!shareId || !docId) notFound();

  // `isRequest` is selected explicitly for the reason the layout above gives: it is not in
  // `PROJECT_SHARE_FIELDS`, and an unselected field reads as `undefined`, which would pass a check
  // while meaning nothing.
  const resolved = await resolveProjectLink(shareId, { select: { isRequest: 1 } });

  // Everything link-level is `../layout.tsx`'s to answer, and it already has, above this file: an
  // unknown slug, a request repo, a deleted project and every disabled/expired/archived link 404
  // there. Nothing is re-decided here. A link that cannot be served has no membership question to
  // ask in the first place, so this steps aside rather than growing a second copy of a rule that
  // would drift from the one above it.
  if (!resolved || resolved.refusal || resolved.project.isRequest) return props.children;

  if (projectLinkPasswordEnabled(resolved.link)) {
    const c = await cookies();
    const cookie = c.get(shareAuthCookieName(shareId))?.value ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: resolved.link.passwordHash as string });
    // Locked, and no key: stop here without touching the room, so the page renders its password
    // gate identically for every id anyone cares to try.
    if (!cookie || cookie !== expected) return props.children;
  }

  const doc = await findProjectDocument(resolved.project, docId);
  if (!doc) notFound();
  return props.children;
}
