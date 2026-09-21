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
import { NextResponse } from "next/server";

import { isBlobStoreHost } from "@/lib/blob/serverClientUploadRoute";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { findProjectDocument, projectLinkPasswordEnabled } from "@/lib/share/projectPublic";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";

export const runtime = "nodejs";

/**
 * Vercel Blob's public CDN, where the upload pipeline writes every preview
 * (`<storeId>.public.blob.vercel-storage.com`, and the bare host on older rows).
 */
const VERCEL_BLOB_HOST = "blob.vercel-storage.com";

/** Nothing our pipeline writes comes close; a first-page PNG is tens of kilobytes. */
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;

/**
 * Which stored preview value this route is willing to go and *dereference* — the same allowlist
 * `/s/:shareId/og.png` applies, and for the same reason.
 *
 * `previewImageUrl` is owner-supplied text. `PATCH /api/uploads/:uploadId` validates it against the
 * upload's own blob folder, but rows written before that check exist, and this route is reachable
 * by anyone holding a slug. Without an allowlist, `http://169.254.169.254/...` or any hostname
 * inside the deployment's network would turn this into an SSRF probe an outsider can time.
 *
 * Another tenant's blob store is still a public, read-only, credential-free CDN, so pointing at one
 * buys nothing; an internal address or a relative path is what this refuses.
 */
function previewFetchUrl(candidate: string): URL | null {
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (isBlobStoreHost(host)) return url;
  return host === VERCEL_BLOB_HOST || host.endsWith(`.${VERCEL_BLOB_HOST}`) ? url : null;
}

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

/**
 * The content type, decided by the bytes — never echoed from upstream.
 *
 * The PDF proxy learned this one the hard way: with the type copied from the store and no
 * `script-src` in the app's CSP, an upstream that answered `text/html` made this origin serve
 * markup. The pipeline writes PNG (`renderPdfFirstPagePngBestEffort`); JPEG is tolerated for older
 * rows. Anything else is not an image we are willing to serve from our own origin.
 */
function pinnedImageMime(bytes: Buffer): string | null {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return "image/png";
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
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
    if (!cookie || cookie !== expected) return new Response("Unauthorized", { status: 401 });
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

  const previewUrl = previewFetchUrl(candidate);
  if (!previewUrl) return NextResponse.json({ error: "No preview" }, { status: 404 });

  const upstream = await fetch(previewUrl, { cache: "no-store" }).catch(() => null);
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

  return new Response(bytes, { status: 200, headers });
}
