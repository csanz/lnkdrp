/**
 * API route for `/api/uploads/:uploadId/import-url`.
 *
 * Imports a publicly accessible PDF from a URL, stores it in Blob, and attaches it to an existing Upload.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { put } from "@vercel/blob";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { buildDocBlobPathname } from "@/lib/blob/clientUpload";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor, type Actor } from "@/lib/gating/actor";

export const runtime = "nodejs";
/**
 * Safe File Name From Url (uses trim, pop, filter).
 */


function safeFileNameFromUrl(rawUrl: string) {
  try {
    const u = new URL(rawUrl);
    const last = (u.pathname.split("/").filter(Boolean).pop() ?? "document.pdf").trim() || "document.pdf";
    return last.toLowerCase().endsWith(".pdf") ? last : `${last}.pdf`;
  } catch {
    return "document.pdf";
  }
}

/**
 * Parse a filename from a Content-Disposition header (best-effort).
 */
function fileNameFromContentDisposition(v: string | null): string | null {
  if (!v) return null;
  const s = v.trim();
  if (!s) return null;

  // filename*=UTF-8''...
  const fnStar = /filename\*\s*=\s*([^;]+)/i.exec(s)?.[1]?.trim() ?? "";
  if (fnStar) {
    const unquoted = fnStar.replace(/^"(.*)"$/, "$1");
    const m = /^[^']*'[^']*'(.*)$/.exec(unquoted);
    const enc = (m?.[1] ?? unquoted).trim();
    try {
      const decoded = decodeURIComponent(enc);
      if (decoded) return decoded;
    } catch {
      // ignore
    }
  }

  const fn = /filename\s*=\s*([^;]+)/i.exec(s)?.[1]?.trim() ?? "";
  if (fn) {
    const unquoted = fn.replace(/^"(.*)"$/, "$1").trim();
    if (unquoted) return unquoted;
  }

  return null;
}

function sanitizeFileName(name: string): string {
  const cleaned = (name ?? "")
    .trim()
    .replace(/[\\/:*?"<>|\u0000-\u001F]+/g, "_")
    .replace(/\s+/g, " ");
  const base = cleaned || "document.pdf";
  return base.toLowerCase().endsWith(".pdf") ? base : `${base}.pdf`;
}

function looksLikePdfBytes(buf: Buffer): boolean {
  // PDFs should contain a "%PDF-" header near the start. Some producers can prepend
  // a few whitespace/BOM bytes, so scan a small prefix and allow leading whitespace.
  if (!buf || buf.length < 5) return false;
  const scanLen = Math.min(buf.length, 2048);
  const sig = Buffer.from("%PDF-", "ascii");

  // Find first non-whitespace byte (ASCII whitespace + UTF-8 BOM).
  let start = 0;
  if (scanLen >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) start = 3;
  while (
    start < scanLen &&
    (buf[start] === 0x09 || buf[start] === 0x0a || buf[start] === 0x0d || buf[start] === 0x20)
  ) {
    start++;
  }
  if (start + sig.length <= scanLen && buf.subarray(start, start + sig.length).equals(sig)) return true;

  // Fallback: search for the signature within the first couple KB.
  const idx = buf.subarray(0, scanLen).indexOf(sig);
  return idx >= 0 && idx <= 64; // keep it conservative; if it's far in, it's likely not a PDF body
}

function isGoogleDriveHost(hostname: string): boolean {
  const h = (hostname || "").toLowerCase();
  return h === "drive.google.com" || h.endsWith(".drive.google.com") || h === "docs.google.com" || h.endsWith(".docs.google.com");
}

function hostFromPublicSiteUrl(): string | null {
  const raw = (process.env.NEXT_PUBLIC_SITE_URL || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw).host;
  } catch {
    return null;
  }
}

function extractLnkdrpShareIdFromSharePageUrl(input: URL, allowedHosts: Set<string>): string | null {
  if (!allowedHosts.has(input.host)) return null;

  const path = input.pathname.replace(/\/+$/, "");
  // Accept share-page URLs like:
  // - /s/:shareId
  // - /share/:shareId (legacy)
  // and convert them to the PDF proxy:
  // - /s/:shareId/pdf
  const m = /^\/(?:s|share)\/([^/]+)$/.exec(path);
  if (!m?.[1]) return null;
  return m[1];
}

function normalizeLnkdrpInternalPdfUrl(input: URL, allowedHosts: Set<string>): { pdfUrl: URL; shareId: string } | null {
  const shareId = extractLnkdrpShareIdFromSharePageUrl(input, allowedHosts);
  if (!shareId) return null;
  return { shareId, pdfUrl: new URL(`/s/${encodeURIComponent(shareId)}/pdf`, input.origin) };
}

function extractGoogleDriveFileId(u: URL): string | null {
  // Supported:
  // - https://drive.google.com/uc?export=download&id=FILEID
  // - https://drive.google.com/file/d/FILEID/view?...
  // - https://drive.google.com/open?id=FILEID
  const id = u.searchParams.get("id");
  if (id) return id;
  const m = /^\/file\/d\/([^/]+)/.exec(u.pathname);
  if (m?.[1]) return m[1];
  return null;
}

function buildGoogleDriveDownloadUrl(fileId: string, confirm?: string): URL {
  const u = new URL("https://drive.google.com/uc");
  u.searchParams.set("export", "download");
  u.searchParams.set("id", fileId);
  if (confirm) u.searchParams.set("confirm", confirm);
  return u;
}

function cookieHeaderFromSetCookies(setCookies: string[]): string {
  // Very small, best-effort cookie jar: take "name=value" for each Set-Cookie.
  const pairs: string[] = [];
  for (const sc of setCookies) {
    const first = (sc || "").split(";")[0]?.trim();
    if (first) pairs.push(first);
  }
  return pairs.join("; ");
}

function extractDriveConfirmTokenFromHtml(html: string): string | null {
  // Google Drive interstitial often includes confirm=TOKEN in links/forms.
  const m1 = /confirm=([0-9A-Za-z-_]+)/.exec(html);
  if (m1?.[1]) return m1[1];
  // Sometimes encoded as confirm%3D...
  const m2 = /confirm%3D([0-9A-Za-z-_]+)/.exec(html);
  if (m2?.[1]) return m2[1];
  return null;
}

async function fetchBytesFollowRedirects(
  url: string,
  headers: Record<string, string>,
): Promise<{ res: Response; buf: Buffer; contentType: string; contentDisposition: string | null; setCookies: string[] }> {
  const res = await fetch(url, { redirect: "follow", headers });
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const contentDisposition = res.headers.get("content-disposition");

  const ab = await res.arrayBuffer();
  const buf = Buffer.from(ab);

  const hAny = res.headers as unknown as { getSetCookie?: () => string[] };
  const setCookies = typeof hAny.getSetCookie === "function"
    ? hAny.getSetCookie()
    : (() => {
        const single = res.headers.get("set-cookie");
        return single ? [single] : [];
      })();

  return { res, buf, contentType, contentDisposition, setCookies };
}
/**
 * As String.
 */


function asString(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/**
 * Import a PDF from a URL into an existing upload.
 *
 * Body: { url: string }
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ uploadId: string }> },
) {
  let actor: Actor | null = null;
  try {
    const { uploadId } = await ctx.params;
    actor = await resolveActor(request);
    if (!Types.ObjectId.isValid(uploadId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid uploadId" }, { status: 400 }), actor);
    }
    const body = (await request.json().catch(() => ({}))) as { url?: unknown };
    const url = asString(body.url)?.trim() ?? "";
    if (!url) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing url" }, { status: 400 }), actor);
    }

    const requestOrigin = new URL(request.url).origin;
    let parsed: URL | null = null;
    try {
      // Allow absolute URLs, and also relative URLs copied from within the app (e.g. "/s/abc").
      parsed = new URL(url, requestOrigin);
    } catch {
      parsed = null;
    }
    if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return applyTempUserHeaders(
        NextResponse.json({ error: "Only http(s) URLs are supported" }, { status: 400 }),
        actor,
      );
    }

    await connectMongo();

    // Authorization: upload must belong to the actor.
    const upload = await UploadModel.findOne({
      _id: new Types.ObjectId(uploadId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    });
    if (!upload) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const docId = upload.docId ? String(upload.docId) : "";
    if (!docId) {
      return applyTempUserHeaders(NextResponse.json({ error: "Upload missing docId" }, { status: 400 }), actor);
    }

    const baseHeaders: Record<string, string> = {
      // Some hosts reject requests without a UA and/or accept header.
      "user-agent": "lnkdrp-import-url/1.0",
      accept: "application/pdf,*/*;q=0.8",
    };

    // Google Drive: normalize to a canonical "uc?export=download&id=" URL so we can
    // handle confirm/virus-scan interstitials.
    let fetchUrl = parsed.toString();
    const isDrive = isGoogleDriveHost(parsed.hostname);
    const driveFileId = isDrive ? extractGoogleDriveFileId(parsed) : null;
    if (driveFileId) {
      fetchUrl = buildGoogleDriveDownloadUrl(driveFileId).toString();
    }

    // lnkdrp: if the user pastes a share-page URL (HTML), rewrite it to our same-origin PDF proxy.
    const allowedHosts = new Set<string>([
      new URL(request.url).host,
      hostFromPublicSiteUrl(),
    ].filter(Boolean) as string[]);
    const internal = normalizeLnkdrpInternalPdfUrl(parsed, allowedHosts);
    if (internal) fetchUrl = internal.pdfUrl.toString();

    debugLog(1, "[import-url] fetching", { uploadId, isDrive: !!driveFileId });
    let first = await fetchBytesFollowRedirects(fetchUrl, baseHeaders);

    // If the share is password-protected, our `/s/:shareId/pdf` proxy will 401 without a share auth cookie.
    // For *owner-owned* shares, allow import by resolving the underlying blobUrl directly from DB.
    if (internal && first.res.status === 401) {
      const owned = await DocModel.findOne({
        shareId: internal.shareId,
        userId: new Types.ObjectId(actor.userId),
        isDeleted: { $ne: true },
      })
        .select({ blobUrl: 1 })
        .lean();

      const blobUrl = owned && typeof (owned as { blobUrl?: unknown }).blobUrl === "string"
        ? ((owned as { blobUrl?: unknown }).blobUrl as string)
        : "";

      if (blobUrl) {
        debugLog(1, "[import-url] share 401; fetching owned blobUrl instead", { uploadId });
        first = await fetchBytesFollowRedirects(blobUrl, baseHeaders);
      }
    }

    if (!first.res.ok) {
      return applyTempUserHeaders(
        NextResponse.json({ error: `Failed to fetch URL (${first.res.status})` }, { status: 400 }),
        actor,
      );
    }

    let buf = first.buf;
    let contentType = first.contentType;
    let contentDisposition = first.contentDisposition;

    // If Drive returns HTML interstitial, try extracting confirm token and re-fetch with cookies.
    if (driveFileId && !looksLikePdfBytes(buf) && contentType.includes("text/html")) {
      const html = buf.toString("utf8");
      const confirm = extractDriveConfirmTokenFromHtml(html);
      if (confirm) {
        const cookie = cookieHeaderFromSetCookies(first.setCookies);
        const headers2: Record<string, string> = { ...baseHeaders };
        if (cookie) headers2.cookie = cookie;

        const confirmUrl = buildGoogleDriveDownloadUrl(driveFileId, confirm).toString();
        debugLog(1, "[import-url] drive confirm fetch", { uploadId });
        const second = await fetchBytesFollowRedirects(confirmUrl, headers2);
        if (second.res.ok) {
          buf = second.buf;
          contentType = second.contentType;
          contentDisposition = second.contentDisposition;
        }
      }
    }

    const sizeBytes = buf.byteLength;
    // Keep a conservative limit to avoid memory pressure.
    const maxBytes = 25 * 1024 * 1024; // 25MB
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return applyTempUserHeaders(NextResponse.json({ error: "Empty PDF" }, { status: 400 }), actor);
    }
    if (sizeBytes > maxBytes) {
      return applyTempUserHeaders(
        NextResponse.json({ error: "PDF is too large (max 25MB)" }, { status: 400 }),
        actor,
      );
    }

    const headerName = fileNameFromContentDisposition(contentDisposition);
    const fileName = sanitizeFileName(headerName || safeFileNameFromUrl(parsed.toString()));

    // IMPORTANT: filename/path suffix is not a reliable signal (many "pdf" links return HTML/XML errors).
    // Require real PDF bytes.
    const looksLikePdf = looksLikePdfBytes(buf) || contentType.includes("application/pdf");
    if (!looksLikePdf) {
      return applyTempUserHeaders(
        NextResponse.json(
          { error: `URL did not return a valid PDF (content-type: ${contentType || "unknown"})` },
          { status: 400 },
        ),
        actor,
      );
    }

    const pathname = buildDocBlobPathname({
      docId,
      uploadId,
      fileName,
    });

    debugLog(1, "[import-url] uploading to blob", { uploadId });
    const blob = await put(pathname, buf, {
      access: "public",
      contentType: "application/pdf",
      addRandomSuffix: false,
    });

    await UploadModel.findByIdAndUpdate(uploadId, {
      status: "uploaded",
      originalFileName: fileName,
      contentType: "application/pdf",
      sizeBytes: sizeBytes,
      blobUrl: blob.url,
      blobPathname: blob.pathname,
      metadata: { size: sizeBytes },
      error: null,
    });

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[import-url] failed", { message });
    const res = NextResponse.json({ error: message }, { status: 400 });
    return actor ? applyTempUserHeaders(res, actor) : res;
  }
}



