/**
 * Segment layout for `/p/:shareId` — it exists to make a refused project link answer **404**.
 *
 * The document tree already has this file (`src/app/s/[shareId]/layout.tsx`); the data-room tree
 * never got the counterpart, and the reason it needs one is the same. `loading.tsx` lives in this
 * segment *and* in `[docId]`, so both pages render inside a Suspense boundary: Next flushes the
 * shell and commits a `200` before the page body runs, and the `notFound()` the page then throws
 * renders the right screen under a status line that says the opposite. Every unknown slug, every
 * document slug pasted into `/p/`, every deleted project, every request repo and every
 * disabled/expired/archived link answered `200 OK` — which is what a crawler indexes, what an
 * uptime monitor calls healthy, and what a link checker calls live.
 *
 * A layout renders *above* its segment's Suspense boundary and is awaited before anything is sent,
 * so a `notFound()` here still reaches the response. The pages keep their own checks: this layout
 * is the status, not the authorization, and each page must stay correct on its own.
 *
 * Two things it deliberately does not cover:
 *
 *  - Route handlers are not wrapped by layouts, so `/p/:shareId/:docId/pdf` and `.../preview` go on
 *    running every check themselves. They do, and they must: they are the ones handing over bytes.
 *  - Refusals now lose their wording. `RefusalNotice` split "expired" from "disabled" because
 *    expiry is the one refusal a recipient can act on — but the body of a 404 is whatever
 *    `/p/not-found.tsx` says, and that file cannot see which slug was asked for, so it cannot tell
 *    the two apart. A correct status with generic copy beats actionable copy served as `200`; the
 *    copy is recoverable by widening `/p/not-found.tsx` to mention expiry, which is not this
 *    change's file to edit.
 *
 * Cost is one extra indexed read per data-room page load (the slug, then the project with the small
 * share projection). Paid deliberately, through the same resolver the pages use rather than a second
 * definition of "servable" that could drift from theirs.
 */
import { notFound } from "next/navigation";

import { resolveProjectLink } from "@/lib/share/projectLinks";

export const dynamic = "force-dynamic";

export default async function ProjectShareLayout(props: {
  children: React.ReactNode;
  params: Promise<{ shareId: string }>;
}) {
  const { shareId } = await props.params;
  if (!shareId) notFound();
  // `isRequest` is selected explicitly for the same reason the page selects it: it is not in
  // `PROJECT_SHARE_FIELDS`, and an unselected field reads as `undefined`, which would pass the
  // check below while meaning nothing. A request repo has no public room at all — see the long note
  // in `page.tsx` — so it is refused here too rather than trusted to the page.
  const resolved = await resolveProjectLink(shareId, { select: { isRequest: 1 } });
  if (!resolved || resolved.refusal || resolved.project.isRequest) notFound();
  return props.children;
}
