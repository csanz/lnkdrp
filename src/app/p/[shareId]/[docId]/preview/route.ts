/**
 * Same-origin preview-image proxy for a document in a data room: `/p/:shareId/:docId/preview`.
 *
 * Why it exists: `/p/:shareId` rendered each card's thumbnail straight from `previewImageUrl`, and
 * `/p/:shareId/:docId` did the same on its "still preparing a PDF viewer" fallback. That value is a
 * Vercel Blob URL on a **public, unauthenticated CDN** — `docs/<docId>/uploads/<uploadId>/
 * preview.png` — so the room's HTML handed every visitor a permanent, link-independent copy of the
 * first page of every document in it, with the internal document and upload ids spelled out in the
 * path. Revoking the link, letting it expire, or adding a password did nothing to a URL somebody
 * had already saved, and a password-protected room that a recipient had once unlocked was leaking
 * bytes that no longer required the password.
 *
 * This is the twin of `/s/:shareId/og.png`'s dereference rules and of `/p/:shareId/:docId/pdf`'s
 * gate ordering, and a separate file rather than a branch inside either, for the same reason the
 * PDF proxy is separate from the document one: these routes share a shape, not a module.
 *
 * The check order is load-bearing and matches the page and the PDF proxy: link, link-level
 * refusals, password, *then* membership. A locked room must answer every candidate document id
 * identically, here as much as there, or the thumbnail route becomes the inventory oracle the
 * password gate exists to withhold.
 *
 * No analytics. A thumbnail is not a read: the room's grid fetches one of these per document on
 * every load, and counting them would invent viewers and downloads that never happened.
 */
import crypto from "node:crypto";
import { NextResponse } from "next/server";

import { fetchStoredBlob } from "@/lib/blob/fetchStoredBlob";
import { pinnedImageMime } from "@/lib/share/pinnedImageMime";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { findProjectDocument, projectLinkPasswordEnabled } from "@/lib/share/projectPublic";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { shareAuthCookieMatches } from "@/lib/share/cookieCompare";

export const runtime = "nodejs";

/** Nothing our pipeline writes comes close; a first-page PNG is tens of kilobytes. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/** Minimal cookie read: the share-auth value is opaque hex and needs no decoding. */
function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || "";
  }
  return null;
}


export async function GET(request: Request, ctx: { params: Promise<{ shareId: string; docId: string }> }) {
  const { shareId, docId } = await ctx.params;
  if (!shareId || !docId) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const resolvedLink = await resolveProjectLink(shareId, { select: { isRequest: 1 } });
  if (!resolvedLink) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A request repo has no public room — the rule, and why, is at `/p/[shareId]/page.tsx`. Asked
  // again here because this route hands over bytes and must not depend on the page having asked.
  if (resolvedLink.project.isRequest) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (resolvedLink.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { link, project } = resolvedLink;

  if (projectLinkPasswordEnabled(link)) {
    const cookie = getCookie(request, shareAuthCookieName(shareId)) ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: link.passwordHash as string });
    if (!shareAuthCookieMatches(cookie, expected)) return new Response("Unauthorized", { status: 401 });
  }

  // Membership after the gate, exactly as on the page and the PDF proxy: while the password is up,
  // a member id and an invented one must look the same.
  const doc = await findProjectDocument(project, docId, { select: { previewImageUrl: 1, firstPagePngUrl: 1 } });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const candidate =
    (typeof doc.previewImageUrl === "string" && doc.previewImageUrl.trim()) ||
    (typeof doc.firstPagePngUrl === "string" && doc.firstPagePngUrl.trim()) ||
    "";
  if (!candidate) return NextResponse.json({ error: "No preview" }, { status: 404 });

  /**
   * A room grid asks for every document's thumbnail on every render, and each answer was a
   * buffered blob fetch. The stored pointer names the bytes (a new upload writes a new URL), so a
   * digest of it is the entity tag: a browser that already holds this thumbnail revalidates with
   * `If-None-Match` and is answered 304 before the blob is fetched. The link's own checks above
   * still run on every request, so a revoked link stops answering 304 as surely as 200.
   */
  const etag = `"${crypto.createHash("sha256").update(candidate).digest("hex").slice(0, 32)}"`;
  const ifNoneMatch = (request.headers.get("if-none-match") ?? "").split(",").map((t) => t.trim());
  if (ifNoneMatch.includes(etag)) {
    return new Response(null, { status: 304, headers: { etag, "cache-control": "private, max-age=300" } });
  }

  /**
   * Which stored pointer this route is willing to go and *dereference*, decided by
   * `fetchStoredBlob` rather than by a predicate of our own.
   *
   * `previewImageUrl` is owner-supplied text. `PATCH /api/uploads/:uploadId` checks it against the
   * upload's own blob folder now, but rows written before that check exist, and this route is
   * reachable by anyone holding a slug. Without an allowlist, `http://169.254.169.254/...` or any
   * hostname inside the deployment's network would turn this into an SSRF probe an outsider can
   * time.
   *
   * This file used to carry its own copy of that allowlist and then hand the result to a bare
   * `fetch`, which follows redirects by default. So the check only ever saw hop zero: an
   * allowlisted pointer answering `302 Location: http://169.254.169.254/...` was still
   * dereferenced and its body still came back through this origin. A reader auditing the host
   * predicate would have found it correct and concluded the route was covered, because what was
   * missing was not the predicate but the second lock. The other four blob-dereferencing routes
   * were converted to the shared helper and this one was left behind, which is how the helper's
   * own docstring came to claim a call site it did not have.
   *
   * `fetchStoredBlob` re-applies the same allowlist to every hop and refuses a chain, so there is
   * no local copy left here to drift out of step with the twin at `/s/:shareId/preview`.
   */
  const upstream = await fetchStoredBlob(candidate).catch(() => null);
  if (!upstream || !upstream.ok) return NextResponse.json({ error: "No preview" }, { status: 404 });

  const declaredLength = Number(upstream.headers.get("content-length") ?? "");
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PREVIEW_BYTES) {
    return NextResponse.json({ error: "No preview" }, { status: 404 });
  }
  const bytes = Buffer.from(await upstream.arrayBuffer());
  if (bytes.length > MAX_PREVIEW_BYTES) return NextResponse.json({ error: "No preview" }, { status: 404 });

  const mime = pinnedImageMime(bytes);
  if (!mime) return NextResponse.json({ error: "No preview" }, { status: 404 });

  const headers = new Headers();
  headers.set("content-type", mime);
  headers.set("content-length", String(bytes.length));
  // `nosniff` because the type above is ours, not the store's: a browser must not second-guess it.
  headers.set("x-content-type-options", "nosniff");
  /**
   * `private`, because these bytes are scoped to whoever got past the gate above — a shared cache is
   * keyed on the URL alone and would serve a locked room's first pages to anyone who asked. Five
   * minutes, not the hour the PDF proxy holds, because a thumbnail is re-fetched on every render of
   * the room grid and this is the window in which a revoked link keeps showing its contents to a
   * browser that already has them.
   */
  headers.set("cache-control", "private, max-age=300");
  headers.set("etag", etag);

  return new Response(bytes, { status: 200, headers });
}
