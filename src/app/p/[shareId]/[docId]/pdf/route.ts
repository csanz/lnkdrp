/**
 * Same-origin PDF proxy for a document opened through a project link: `/p/:shareId/:docId/pdf`.
 *
 * The project-link twin of `/s/:shareId/pdf`, and a separate route rather than a branch inside that
 * one because the two differ on the only three things the route does: which link authorises the
 * request (this one's `allowDownload`, never the document's), which analytics row a download lands
 * on (`projectViewerKey`, so three documents behind one link do not collide on `{shareId,
 * botIdHash}`), and the extra `ProjectLinkView` counter a project landing owns.
 *
 * Everything else is deliberately identical, including the parts that are easy to get wrong and
 * were got wrong once already on the document route: the owner side is resolved **before** any
 * counter moves (an owner downloading their own deck must not bump the link's `downloadCount` or
 * write "Someone downloaded this" into their own feed), a duplicate-key race still increments, and
 * Range requests pass through untouched because pdf.js depends on them.
 *
 * The order of the checks in `GET` is load-bearing and matches the page's: link, then password, then
 * membership. A locked room must answer every candidate document id the same way, here as much as
 * there — see the note in the handler.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";

import { recordActivity } from "@/lib/activity/log";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { ProjectLinkViewModel } from "@/lib/models/ProjectLinkView";
import { DOWNLOAD_INSTANTS_KEPT, ShareViewModel } from "@/lib/models/ShareView";
import { touchShareLink } from "@/lib/share/links";
import { isOwnerSideViewer } from "@/lib/share/ownerSide";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { findProjectDocument, projectLinkPasswordEnabled, projectViewerKey } from "@/lib/share/projectPublic";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { clientIpFromRequest, rateLimit } from "@/lib/http/rateLimit";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { blobFetchUrl, fetchStoredBlob } from "@/lib/blob/fetchStoredBlob";

export const runtime = "nodejs";

/** Analytics-write budget per caller. The twin of the same constants on `/s/:shareId/pdf`. */
const DOWNLOAD_TRACK_PER_LINK_LIMIT = 30;
const DOWNLOAD_TRACK_PER_IP_LIMIT = 120;
const DOWNLOAD_TRACK_WINDOW_MS = 60_000;



/**
 *
 */
function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * True when a `Range` header asks for something other than the beginning of the file.
 *
 * One read arrives as several GETs carrying the same `botId`, and each chunk used to count as its
 * own download. Only the request that starts at byte 0 is the read; an unparseable header counts,
 * so nothing legitimate is ever lost to a shape we did not anticipate.
 */
function rangeStartsAfterFirstByte(raw: string | null): boolean {
  if (!raw) return false;
  const m = /^bytes\s*=\s*(\d*)\s*-/i.exec(raw.trim());
  if (!m) return false;
  // `bytes=-500` is a suffix range: the tail of the file, never its start.
  if (m[1] === "") return true;
  return Number(m[1]) > 0;
}

/**
 * True when this request is a client *taking* the file, rather than the room's viewer reading it.
 *
 * The twin of the same helper on `/s/:shareId/pdf`, and duplicated for the same reason the rest of
 * this file's small helpers are: the two routes share a shape, not a module.
 *
 * `Sec-Fetch-Site` and `Sec-Fetch-Dest` are stamped by the browser and cannot be set from page
 * script. The viewer's loads are always `same-origin` and land on `empty` (pdf.js fetch/XHR) or
 * `iframe` (the native-PDF fallback frame); a bare navigation reports `none`, a foreign embed
 * `cross-site`, and a top-level open `dest: document`. A request with no Fetch Metadata at all is
 * served on purpose — old browsers omit the headers, as does the product's own server-side
 * importer, and refusing them would break real reads to inconvenience a client that can send
 * whatever headers it chooses. See the long note on the document route for what this does and does
 * not close.
 */
function isRawFileRequest(request: Request): boolean {
  const site = request.headers.get("sec-fetch-site");
  if (!site) return false;
  if (site !== "same-origin") return true;
  return request.headers.get("sec-fetch-dest") === "document";
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

/** Copy an upstream header through, or fall back. */
function pickHeader(src: Headers, dst: Headers, name: string, opts?: { fallback?: string }) {
  const v = src.get(name);
  if (typeof v === "string" && v) {
    dst.set(name, v);
    return;
  }
  if (opts?.fallback) dst.set(name, opts.fallback);
}

/**
 *
 */
function safePdfFilename(input: string | null | undefined): string {
  const base = (input ?? "").toString().trim() || "document";
  const cleaned = base
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const withExt = cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
  return withExt || "document.pdf";
}

/** Activity feed: "downloaded", carrying the project so the feed can say which data room it was. */
async function recordProjectDownloadActivity(input: {
  doc: Record<string, unknown>;
  projectId: string;
  projectName: string | null;
  shareId: string;
  viewKey: string;
  request: Request;
  link: { label: string | null; isDefault: boolean };
  viewer: { userId: string | null };
}) {
  try {
    const ownerUserId = input.doc.userId ? new Types.ObjectId(String(input.doc.userId)) : null;
    const orgId = input.doc.orgId
      ? String(input.doc.orgId)
      : ownerUserId
        ? String((await ensurePersonalOrgForUserId({ userId: ownerUserId })).orgId)
        : null;
    if (!orgId) return;
    // Attribution only: an unnamed row beats a missing one, so the lookup may fail silently.
    const known = (await ShareViewModel.findOne({ shareId: input.shareId, botIdHash: input.viewKey })
      .select({ viewerName: 1, viewerEmail: 1 })
      .lean()
      .catch(() => null)) as { viewerName?: string | null; viewerEmail?: string | null } | null;
    await recordActivity({
      orgId,
      userId: input.viewer.userId,
      actorKind: "viewer",
      type: "share.downloaded",
      docId: String(input.doc._id),
      title: typeof input.doc.title === "string" ? input.doc.title : null,
      meta: {
        shareId: input.shareId,
        linkLabel: input.link.label,
        isDefaultLink: input.link.isDefault,
        // The composite key, so the feed's `viewerKey` join finds the row it names (the lookup is
        // `ShareView.findOne({ shareId, botIdHash: viewerKey })`).
        viewerKey: input.viewKey,
        viewerName: known?.viewerName ?? null,
        viewerEmail: known?.viewerEmail ?? null,
        // New for project links: which data room the download happened in.
        projectId: input.projectId,
        projectName: input.projectName,
      },
      request: input.request,
    });
  } catch {
    // best-effort
  }
}

/**
 *
 */
export async function GET(request: Request, ctx: { params: Promise<{ shareId: string; docId: string }> }) {
  const { shareId, docId } = await ctx.params;
  if (!shareId || !docId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 });

  const url = new URL(request.url);
  const wantsDownload = url.searchParams.get("download") === "1";
  const botId = url.searchParams.get("botId");
  const viewerIp = clientIpFromRequest(request) || null;

  /**
   * The link first, the password next, the document only after that — the same order the page above
   * now uses (`/p/[shareId]/[docId]/page.tsx`), and here for the same reason.
   *
   * This route resolved link *and* document in one `resolveProjectDocument` call and answered a
   * non-member id with 404 `Not found`, a member id with no bytes 404 `PDF not available`, and only
   * *then* asked for the password. So the page's fix closed the oracle on the page and left it wide
   * open one path deeper: `GET /p/<locked slug>/<candidate docId>/pdf` with no cookie still sorted
   * candidate ids into "in this room" (401) and "not in this room" (404), which is the document
   * inventory the password gate exists to withhold.
   *
   * The ordering below is the whole fix. Link-level refusals stay ahead of the gate because they are
   * properties of the link the recipient already holds, not of its contents. Everything after the
   * gate — the membership check, the missing-bytes 404, the download gate, the analytics — is
   * untouched: behind the password the answers are allowed to differ again, because by then the
   * caller has the password.
   */
  const resolvedLink = await resolveProjectLink(shareId, { select: { isRequest: 1 } });
  if (!resolvedLink) return NextResponse.json({ error: "Not found" }, { status: 404 });
  // A request repo has no public room — the rule, and why, is at `/p/[shareId]/page.tsx`. This
  // route is the one that actually hands the file over, so it asks for itself rather than trusting
  // the page above it to have asked.
  if (resolvedLink.project.isRequest) return NextResponse.json({ error: "Not found" }, { status: 404 });
  if (resolvedLink.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { link, project } = resolvedLink;

  if (projectLinkPasswordEnabled(link)) {
    const cookie = getCookie(request, shareAuthCookieName(shareId)) ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: link.passwordHash as string });
    if (!cookie || cookie !== expected) return new Response("Unauthorized", { status: 401 });
  }

  // Membership is re-proved here, not trusted from the URL: this route hands out bytes. The only
  // change is that it now happens after the gate, exactly as on the page.
  const doc = await findProjectDocument(project, docId, { select: { blobUrl: 1, title: 1, fileName: 1, orgId: 1, userId: 1 } });
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const blobUrl = typeof doc.blobUrl === "string" ? doc.blobUrl : "";
  if (!blobUrl) return NextResponse.json({ error: "PDF not available" }, { status: 404 });
  // A pointer we will not dereference is the same answer as no pointer — see `blobFetchUrl`. Here,
  // beside the empty check and ahead of the analytics writes, so a refused row is never counted as
  // a download and never escapes this handler as a 500 from an unresolvable host. The owner sees
  // the viewer's "PDF not available" until the file is re-uploaded through the validated path.
  const pdfUrl = blobFetchUrl(blobUrl);
  if (!pdfUrl) return NextResponse.json({ error: "PDF not available" }, { status: 404 });

  // PRD decision 3: the project link's flag governs every document opened through it. A document
  // whose own link allows downloads is still not downloadable to *this* audience unless the sender
  // said so on this link.
  //
  // The gate read `wantsDownload && !link.allowDownload`, so the lock was a query parameter the
  // caller supplies: dropping `?download=1` handed over the same bytes with an inline disposition,
  // and every document in a no-download data room could be walked off with one URL at a time.
  // `?download=1` picks the disposition header and nothing else, so the gate asks what the request
  // *is* instead (`isRawFileRequest`); the room's viewer fetches are untouched.
  if (!link.allowDownload && (wantsDownload || isRawFileRequest(request))) {
    return new Response("Download disabled", { status: 403 });
  }

  const downloadSession = wantsDownload ? await tryResolveAuthUserId(request) : null;
  const ownerPreview = wantsDownload ? await isOwnerSideViewer(doc as { orgId?: unknown; userId?: unknown }, downloadSession?.userId ?? null) : false;

  // The same bound the document route now carries, and for the same reason — this route is the
  // louder half of the pair, because one project link fans out over every document in the room and
  // each `?download=1&botId=<anything>` writes *two* rows (`ShareView` plus the `ProjectLinkView`
  // landing row) as well as the activity entry. The caller picks the analytics key, the route is
  // unauthenticated, and `Range: bytes=0-0` made each invented reader cost about a byte.
  //
  // Blocked callers are still served their PDF: only the counter move is withheld. The limiter key
  // comes from `clientIpFromRequest`, which reads only proxy-set forwarding headers — a direct
  // caller cannot rotate buckets by inventing one.
  const rangeHeader = request.headers.get("range");
  const trackingBotId = typeof botId === "string" && botId.trim() ? botId.trim() : null;
  let trackDownload = wantsDownload && Boolean(trackingBotId) && !rangeStartsAfterFirstByte(rangeHeader);
  if (trackDownload) {
    const limiterIp = clientIpFromRequest(request);
    const [perLink, perIp] = await Promise.all([
      rateLimit({
        key: `sharepdf:${shareId}:${limiterIp}`,
        limit: DOWNLOAD_TRACK_PER_LINK_LIMIT,
        windowMs: DOWNLOAD_TRACK_WINDOW_MS,
      }),
      rateLimit({ key: `sharepdf:ip:${limiterIp}`, limit: DOWNLOAD_TRACK_PER_IP_LIMIT, windowMs: DOWNLOAD_TRACK_WINDOW_MS }),
    ]);
    trackDownload = perLink.ok && perIp.ok;
  }

  if (trackDownload && trackingBotId) {
    const botIdHash = crypto.createHash("sha256").update(trackingBotId).digest("hex");
    // One row per (link, viewer, document) — see `projectViewerKey` for why the document is carried
    // inside the key rather than beside it.
    const viewKey = projectViewerKey(botIdHash, doc._id);
    const day = utcDayKey(new Date());
    const docOrgId = doc.orgId ? new Types.ObjectId(String(doc.orgId)) : null;
    try {
      const dl = await ShareViewModel.updateOne(
        { shareId, botIdHash: viewKey },
        {
          $setOnInsert: { shareId, docId: doc._id, botIdHash: viewKey, pagesSeen: [] },
          $set: {
            shareLinkId: link._id,
            ...(docOrgId ? { orgId: docOrgId } : {}),
            ...(viewerIp ? { viewerIp } : {}),
            isOwnerPreview: ownerPreview,
            lastViewedAt: new Date(),
          },
          $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
            // The instant, for the visit brief: which sitting was this download part of?
            $push: { downloadedAt: { $each: [new Date()], $slice: -DOWNLOAD_INSTANTS_KEPT } },
        },
        { upsert: true },
      );
      // A `ShareView` row is a view everywhere downstream, so a download from a device we have
      // never seen has to move what a first view moves — but on **this** route that is a project
      // link, and a read through a project link is the project's view, not the document's
      // (docs/METRICS.md, `@/lib/analytics/docScope`). The link's own counter moves; the
      // document's `numberOfViews` deliberately does not, because no document-scoped figure counts
      // this row.
      if ((dl as { upsertedCount?: number })?.upsertedCount && !ownerPreview) {
        void touchShareLink(shareId, "view", { countView: true });
      }
      if (!ownerPreview) void touchShareLink(shareId, "download");
    } catch {
      // Duplicate-key race: retry the increments without the upsert, so the counters survive
      // exactly the collision they were meant to survive.
      try {
        await ShareViewModel.updateOne(
          { shareId, botIdHash: viewKey },
          {
            $set: { shareLinkId: link._id, ...(viewerIp ? { viewerIp } : {}), isOwnerPreview: ownerPreview, lastViewedAt: new Date() },
            $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
            // The instant, for the visit brief: which sitting was this download part of?
            $push: { downloadedAt: { $each: [new Date()], $slice: -DOWNLOAD_INSTANTS_KEPT } },
          },
        );
        if (!ownerPreview) void touchShareLink(shareId, "download");
      } catch {
        // Never block a download on tracking.
      }
    }

    // The landing row owns "downloads taken through this link", across every document in the
    // project — the figure a data-room sender actually asks for. Keyed on the bare `botIdHash`:
    // this row is about the person, not the document.
    try {
      await ProjectLinkViewModel.updateOne(
        { shareId, botIdHash },
        {
          $setOnInsert: { shareId, projectId: project._id, botIdHash, firstViewedAt: new Date() },
          $set: {
            shareLinkId: link._id,
            ...(project.orgId ? { orgId: project.orgId } : {}),
            ...(viewerIp ? { viewerIp } : {}),
            isOwnerPreview: ownerPreview,
            lastViewedAt: new Date(),
          },
          $addToSet: { docsOpened: doc._id },
          $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
            // The instant, for the visit brief: which sitting was this download part of?
            $push: { downloadedAt: { $each: [new Date()], $slice: -DOWNLOAD_INSTANTS_KEPT } },
        },
        { upsert: true },
      );
    } catch {
      // best-effort
    }

    if (!ownerPreview) {
      void recordProjectDownloadActivity({
        doc: doc as Record<string, unknown>,
        projectId: String(project._id),
        projectName: typeof project.name === "string" ? project.name : null,
        shareId,
        viewKey,
        request,
        link: { label: link.label ?? null, isDefault: Boolean(link.isDefault) },
        viewer: { userId: downloadSession?.userId ? String(downloadSession.userId) : null },
      });
    }
  }

  // Range passes through untouched: pdf.js depends on it, and the limiter above only decided whether
  // this chunk counted, never whether it is served.
  // Not a plain `fetch`: `fetchStoredBlob` re-applies the allowlist to every redirect, so a stored
  // URL that answers 302 to somewhere off the store is refused rather than followed. The early
  // `blobFetchUrl` check above only ever saw the first hop.
  const upstream = await fetchStoredBlob(pdfUrl.toString(), { headers: rangeHeader ? { range: rangeHeader } : undefined });
  if (!upstream) return NextResponse.json({ error: "PDF not available" }, { status: 404 });

  const headers = new Headers();
  // Pinned, not copied. These routes serve one thing — the stored PDF — so echoing the upstream
  // `content-type` bought nothing and cost everything: with `content-disposition: inline` and no
  // `script-src` in the app's CSP, an upstream that answered `text/html` made this origin serve
  // attacker markup and script. The write path that made that reachable is closed
  // (`blobUrl` is no longer patchable), and this is the second lock: even a blob the store itself
  // mislabels can only ever be delivered as a PDF.
  headers.set("content-type", "application/pdf");
  pickHeader(upstream.headers, headers, "content-length");
  pickHeader(upstream.headers, headers, "content-range");
  pickHeader(upstream.headers, headers, "accept-ranges");
  pickHeader(upstream.headers, headers, "etag");
  pickHeader(upstream.headers, headers, "last-modified");
  // Project links can be password protected; keep caching private.
  headers.set("cache-control", "private, max-age=3600");
  headers.set(
    "content-disposition",
    `${wantsDownload ? "attachment" : "inline"}; filename="${safePdfFilename(
      (doc.fileName as string | null | undefined) ?? (doc.title as string | null | undefined),
    )}"`,
  );

  return new Response(upstream.body, { status: upstream.status, headers });
}
