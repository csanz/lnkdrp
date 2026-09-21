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
import { actorRateLimitResponse } from "@/lib/gating/actorRateLimit";
import { applyTempUserHeaders, resolveActor, type Actor } from "@/lib/gating/actor";
import { safeFetchUrl, SafeFetchError } from "@/lib/http/safeFetchUrl";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { PDF_ONLY_ERROR_MESSAGE, UNSUPPORTED_FILE_TYPE_CODE, looksLikePdfBytes, sanitizeFileName } from "@/lib/blob/serverClientUploadRoute";
import { recordActivity } from "@/lib/activity/log";
import { abandonUploadIfImportFailed } from "@/lib/uploads/abandonUpload";
import { createUploadProgressReporter } from "@/lib/uploads/progressWriter";
import { UPLOAD_MAX_BYTES, UPLOAD_MAX_LABEL } from "@/lib/limits/uploads";

export const runtime = "nodejs";
export const maxDuration = 300;

/**
 * Download ceiling — the single upload limit (src/lib/limits/uploads.ts), the same number the
 * inline `import-bytes` path enforces. Unlike that path this one has no platform body limit above
 * it: the bytes arrive as a *response* body this function reads itself, so the full limit is real
 * here. `maxDuration` above is what actually bounds a slow 50MB fetch.
 */
const IMPORT_MAX_BYTES = UPLOAD_MAX_BYTES;
/** Per-download timeout (DNS + connect + body). */
const IMPORT_TIMEOUT_MS = 60_000;
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

/**
 * Return whether the upstream `Content-Type` is acceptable for a PDF import.
 *
 * Accepts `application/pdf` (and the legacy `application/x-pdf`), `application/octet-stream` or a
 * missing type when the URL/filename ends in `.pdf`, and the Google Drive / lnkdrp share-proxy
 * flows that already produce PDFs. The magic-byte check (`looksLikePdfBytes`) is the real gate;
 * this only stops obviously-wrong responses (HTML error pages, images) earlier.
 */
function isAcceptablePdfContentType(params: {
  contentType: string;
  nameLooksPdf: boolean;
  trustedPdfFlow: boolean;
}): boolean {
  const base = (params.contentType.split(";")[0] ?? "").trim().toLowerCase();
  if (base === "application/pdf" || base === "application/x-pdf") return true;
  if (params.trustedPdfFlow) return true;
  if ((base === "application/octet-stream" || base === "") && params.nameLooksPdf) return true;
  return false;
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

/**
 * Download a user-supplied URL through the SSRF-safe fetcher (manual, re-validated redirects;
 * bounded body size + timeout).
 *
 * `allowPrivateNetwork` is only honored outside production (used for same-origin `/s/:id/pdf`
 * proxy fetches against a `localhost` dev server).
 */
async function fetchBytesFollowRedirects(
  url: string,
  headers: Record<string, string>,
  opts?: { allowPrivateNetwork?: boolean },
): Promise<{ res: Response; buf: Buffer; contentType: string; contentDisposition: string | null; setCookies: string[] }> {
  const { response: res, body: buf, setCookies } = await safeFetchUrl(url, {
    maxBytes: IMPORT_MAX_BYTES,
    timeoutMs: IMPORT_TIMEOUT_MS,
    headers,
    maxRedirects: 3,
    allowPrivateNetwork: Boolean(opts?.allowPrivateNetwork) && process.env.NODE_ENV !== "production",
  });
  const contentType = (res.headers.get("content-type") ?? "").toLowerCase();
  const contentDisposition = res.headers.get("content-disposition");
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
async function importUrl(
  request: Request,
  ctx: { params: Promise<{ uploadId: string }> },
  seen: { actor: Actor | null },
) {
  let actor: Actor | null = null;
  try {
    const { uploadId } = await ctx.params;
    actor = await resolveActor(request);
    seen.actor = actor;
    // Viewers must not import files (creates uploads + owner-billed processing).
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;
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

    /**
     * Authorization: the upload must belong to the actor **and** sit in the workspace the actor is
     * acting in.
     *
     * This matched `{ _id, userId }` and called that "the upload must belong to the actor" — the
     * same mistake `GET /api/uploads` made one directory up, except this one ends in a *write*.
     * The other gate, `forbidUnlessOrgRole` above, asks whether the caller may write in the
     * workspace they are *currently* in; it never looks at the upload's. So the two together only
     * ever asked two questions about two different workspaces, and never the one that mattered.
     *
     * An `lnk_` key is attributed to the member who minted it but scoped to *its own* workspace
     * (`apiKeyActor.ts`), so a key minted in workspace B, by someone who had also uploaded into
     * workspace A — or who has since been removed from A — passed both gates and then installed
     * attacker-chosen bytes as a version of A's document. The route already knew: it resolves the
     * document's real org further down for the activity row, and happily logged the write into a
     * workspace the actor was not in.
     *
     * `orgId` is stamped on the upload row at creation from its document, so the bound is on the
     * row itself and no later lookup can reintroduce the gap. `allowLegacyByUserId` is the same
     * concession `src/lib/docs/docMatch.ts` makes: rows that predate workspaces carry no `orgId`
     * and belong to a person, so they resolve only while that person is sitting in their own
     * personal workspace. It goes in `$and` rather than as a top-level `$or` for the reason
     * `/api/uploads` spells out — a later clause assigning `$or` would replace the tenancy one
     * outright, which is how document search lost its scoping once already.
     */
    const orgId = new Types.ObjectId(actor.orgId);
    const actorUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const tenancy = allowLegacyByUserId
      ? { $or: [{ orgId }, { orgId: { $exists: false } }, { orgId: null }] }
      : { orgId };

    const upload = await UploadModel.findOne({
      _id: new Types.ObjectId(uploadId),
      userId: actorUserId,
      isDeleted: { $ne: true },
      $and: [tenancy],
    });
    if (!upload) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const docId = upload.docId ? String(upload.docId) : "";
    if (!docId) {
      return applyTempUserHeaders(NextResponse.json({ error: "Upload missing docId" }, { status: 400 }), actor);
    }

    // Live progress: the download is the first thing that takes real time on this path, and on a
    // large deck it is most of the wait before processing even starts.
    const progress = createUploadProgressReporter({ uploadId, docId, orgId: upload.orgId ? String(upload.orgId) : null });
    await progress.report("downloading", { force: true });

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
    // Same-origin proxy fetches may target a loopback dev server; never relaxed in production.
    let first = await fetchBytesFollowRedirects(fetchUrl, baseHeaders, { allowPrivateNetwork: Boolean(internal) });

    // If the share is password-protected, our `/s/:shareId/pdf` proxy will 401 without a share auth cookie.
    // For *owner-owned* shares, allow import by resolving the underlying blobUrl directly from DB.
    if (internal && first.res.status === 401) {
      // Same workspace bound as the upload lookup above, for the same reason. The `shareId` here
      // comes out of the caller's own request body, so `{ shareId, userId }` alone was a second way
      // in: a key scoped to workspace B could name a password-protected share in workspace A and,
      // because "owner" was decided by `userId` alone, have the server hand over that document's
      // private blob bytes and write them into a document the caller does control. A share the
      // caller can only reach from another workspace now falls through to the ordinary 401.
      const owned = await DocModel.findOne({
        shareId: internal.shareId,
        userId: actorUserId,
        isDeleted: { $ne: true },
        $and: [tenancy],
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
    if (!Number.isFinite(sizeBytes) || sizeBytes <= 0) {
      return applyTempUserHeaders(NextResponse.json({ error: "Empty PDF" }, { status: 400 }), actor);
    }
    if (sizeBytes > IMPORT_MAX_BYTES) {
      return applyTempUserHeaders(
        NextResponse.json({ error: `PDF is too large (max ${UPLOAD_MAX_LABEL})` }, { status: 400 }),
        actor,
      );
    }

    const headerName = fileNameFromContentDisposition(contentDisposition);
    const fileName = sanitizeFileName(headerName || safeFileNameFromUrl(parsed.toString()));

    // Documents are PDF-only: the upstream content-type must be plausible for a PDF *and* the body
    // must carry the "%PDF-" signature. Filename/path suffix alone is not trusted (many "pdf" links
    // return HTML/XML error pages). Nothing is written to Blob unless both checks pass.
    const nameLooksPdf = /\.pdf$/i.test(headerName ?? "") || /\.pdf$/i.test(parsed.pathname);
    const contentTypeOk = isAcceptablePdfContentType({
      contentType,
      nameLooksPdf,
      trustedPdfFlow: Boolean(driveFileId) || Boolean(internal),
    });
    if (!contentTypeOk || !looksLikePdfBytes(buf)) {
      debugLog(1, "[import-url] rejected non-PDF response", {
        uploadId,
        contentType: contentType || "unknown",
        contentTypeOk,
        pdfSignature: looksLikePdfBytes(buf),
      });
      return applyTempUserHeaders(
        NextResponse.json({ error: PDF_ONLY_ERROR_MESSAGE, code: UNSUPPORTED_FILE_TYPE_CODE }, { status: 415 }),
        actor,
      );
    }

    const pathname = buildDocBlobPathname({
      docId,
      uploadId,
      fileName,
    });

    debugLog(1, "[import-url] uploading to blob", { uploadId });
    await progress.report("storing", { force: true });
    const blob = await put(pathname, buf, {
      access: "public",
      contentType: "application/pdf",
      addRandomSuffix: false,
    });
    await progress.report("stored", { force: true });

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

    // Activity (best-effort, after the primary write).
    const activityDoc = await DocModel.findById(docId).select({ orgId: 1, title: 1 }).lean().catch(() => null);
    const activityDocOrgId =
      activityDoc && (activityDoc as { orgId?: unknown }).orgId ? String((activityDoc as { orgId?: unknown }).orgId) : null;
    void recordActivity({
      orgId: activityDocOrgId ?? actor.orgId,
      userId: actor.userId,
      actorKind: actor.kind,
      type: "doc.imported_url",
      docId,
      uploadId,
      title:
        activityDoc && typeof (activityDoc as { title?: unknown }).title === "string"
          ? (activityDoc as { title: string }).title
          : null,
      meta: {
        sourceHost: parsed.hostname,
        fileName,
        sizeBytes,
        version: Number.isFinite(upload.version) ? Number(upload.version) : null,
      },
      request,
    });

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const limited = actorRateLimitResponse(err);
    if (limited) return limited;
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[import-url] failed", { message, code: err instanceof SafeFetchError ? err.code : undefined });
    const friendly =
      err instanceof SafeFetchError
        ? err.code === "BODY_TOO_LARGE"
          ? `PDF is too large (max ${UPLOAD_MAX_LABEL})`
          : err.code === "PRIVATE_ADDRESS" || err.code === "UNSUPPORTED_PROTOCOL"
            ? "URL is not allowed"
            : err.code === "TIMEOUT"
              ? "Timed out fetching URL"
              : message
        : message;
    const res = NextResponse.json({ error: friendly }, { status: 400 });
    return actor ? applyTempUserHeaders(res, actor) : res;
  }
}

/**
 * `POST` — imports the file, and when the import fails abandons the upload so its document goes
 * back to its last good version instead of sitting in `preparing` forever (see abandonUpload).
 */
export async function POST(request: Request, ctx: { params: Promise<{ uploadId: string }> }) {
  const seen: { actor: Actor | null } = { actor: null };
  const res = await importUrl(request, ctx, seen);
  if (!res.ok) await abandonUploadIfImportFailed(res, (await ctx.params).uploadId, seen.actor);
  return res;
}
