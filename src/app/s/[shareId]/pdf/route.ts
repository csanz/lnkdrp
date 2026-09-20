import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { recordActivity } from "@/lib/activity/log";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { resolveShareLink, touchShareLink } from "@/lib/share/links";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { isOwnerSideViewer } from "@/lib/share/ownerSide";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { clientIpFromRequest, rateLimit } from "@/lib/http/rateLimit";
import crypto from "node:crypto";

export const runtime = "nodejs";

/**
 * How much analytics one caller may write through this proxy.
 *
 * A real reader on a real link opens a handful of documents a minute; these are generous enough that
 * nobody legitimate ever meets them, and low enough that the flood this bounds (see the comment at
 * the tracking block) is not worth an attacker's time.
 */
const DOWNLOAD_TRACK_PER_LINK_LIMIT = 30;
/** Wider bucket, so a caller cannot simply walk across every link they hold to dodge the first. */
const DOWNLOAD_TRACK_PER_IP_LIMIT = 120;
const DOWNLOAD_TRACK_WINDOW_MS = 60_000;
/**
 * Utc Day Key (uses slice, toISOString).
 */


function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}
/**
 * Pick First Forwarded Ip (uses trim, split).
 */


function pickFirstForwardedIp(v: string): string {
  return v.split(",")[0]?.trim() ?? "";
}
/**
 * Normalize Ip (uses trim, startsWith, includes).
 */


function normalizeIp(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  if (s.length > 128) return null;

  // Handle bracketed IPv6 like "[::1]:1234"
  if (s.startsWith("[") && s.includes("]")) {
    const inside = s.slice(1, s.indexOf("]")).trim();
    return inside || null;
  }

  // Strip port for "1.2.3.4:5678"
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
    return s.slice(0, s.lastIndexOf(":"));
  }

  return s;
}
/**
 * Get client ip.
 */


function getClientIp(request: Request): string | null {
  const h = request.headers;
  const candidates = [
    h.get("cf-connecting-ip"),
    h.get("true-client-ip"),
    h.get("x-real-ip"),
    h.get("x-forwarded-for"),
    h.get("x-vercel-forwarded-for"),
  ];
  for (const c of candidates) {
    if (typeof c !== "string" || !c.trim()) continue;
    const first = c.includes(",") ? pickFirstForwardedIp(c) : c.trim();
    const ip = normalizeIp(first);
    if (ip) return ip;
  }
  return null;
}
/**
 * Get cookie.
 */


function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  // Minimal cookie parsing (no decoding needed for our values).
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || "";
  }
  return null;
}
/**
 * Pick Header (uses get, set).
 */


function pickHeader(src: Headers, dst: Headers, name: string, opts?: { fallback?: string }) {
  const v = src.get(name);
  if (typeof v === "string" && v) {
    dst.set(name, v);
    return;
  }
  if (opts?.fallback) dst.set(name, opts.fallback);
}
/**
 * Safe Pdf Filename (uses trim, toString, slice).
 */


function safePdfFilename(input: string | null | undefined): string {
  const base = (input ?? "").toString().trim() || "document";
  const cleaned = base
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const withExt = cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
  return withExt || "document.pdf";
}

/**
 * True when a `Range` header asks for something other than the beginning of the file.
 *
 * One read arrives here as several GETs: a reader that fetches a PDF in pieces repeats the same
 * `botId` on each chunk, and every one of them used to be counted as its own download. Only the
 * request that starts at byte 0 is treated as the read; its continuations are served without
 * touching a counter. Anything unparseable is treated as the start, so a header shape we did not
 * anticipate loses bytes to nobody — it just counts, exactly as before.
 */
function rangeStartsAfterFirstByte(raw: string | null): boolean {
  if (!raw) return false;
  const m = /^bytes\s*=\s*(\d*)\s*-/i.exec(raw.trim());
  if (!m) return false;
  // `bytes=-500` is a suffix range: it names the tail of the file, never its start.
  if (m[1] === "") return true;
  return Number(m[1]) > 0;
}

/**
 * Same-origin PDF proxy for `/s/:shareId`.
 *
 * - Supports Range requests (PDF.js uses them).
 * - If password-protected, requires the share auth cookie.
 * - If `?download=1`, enforces `doc.shareAllowPdfDownload` and sets attachment headers.
 */
/** Activity feed: "downloaded" event for the owner's workspace (best-effort, never blocks the download). */
async function recordDownloadActivity(
  doc: Record<string, unknown>,
  shareId: string,
  request: Request,
  linkMeta: { linkLabel: string | null; isDefaultLink: boolean },
  viewer: { userId: string | null; botId: string | null },
) {
  try {
    const ownerUserId = doc.userId ? new Types.ObjectId(String(doc.userId)) : null;
    const orgId = doc.orgId
      ? String(doc.orgId)
      : ownerUserId
        ? String((await ensurePersonalOrgForUserId({ userId: ownerUserId })).orgId)
        : null;
    if (!orgId) return;
    // Name the downloader when we know them: a signed-in recipient, or one who introduced themselves
    // on the share page (their ShareView row carries the name). The viewer key lets the feed pick up
    // a name given later, the same way view rows do.
    const viewerKey = viewer.botId && viewer.botId.trim() ? crypto.createHash("sha256").update(viewer.botId.trim()).digest("hex") : null;
    // Attribution only: if the lookup fails the row is still written, just unnamed.
    const known = viewerKey
      ? ((await ShareViewModel.findOne({ shareId, botIdHash: viewerKey })
          .select({ viewerName: 1, viewerEmail: 1 })
          .lean()
          .catch(() => null)) as { viewerName?: string | null; viewerEmail?: string | null } | null)
      : null;
    await recordActivity({
      orgId,
      userId: viewer.userId,
      actorKind: "viewer",
      type: "share.downloaded",
      docId: String(doc._id),
      title: typeof doc.title === "string" ? doc.title : null,
      meta: {
        shareId,
        linkLabel: linkMeta.linkLabel,
        isDefaultLink: linkMeta.isDefaultLink,
        viewerKey,
        viewerName: known?.viewerName ?? null,
        viewerEmail: known?.viewerEmail ?? null,
      },
      request,
    });
  } catch {
    // best-effort
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await ctx.params;
  if (!shareId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 });

  const url = new URL(request.url);
  const wantsDownload = url.searchParams.get("download") === "1";
  const botId = url.searchParams.get("botId");
  const viewerIp = getClientIp(request);

  // One link → one document; a refused link (disabled/expired/archived) is a 404, exactly as a
  // slug that never existed (docs/prds/lnkdrp-multi-links.md).
  const resolved = await resolveShareLink(shareId, {
    select: { blobUrl: 1, title: 1, fileName: 1 } as Record<string, 1>,
  });
  if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { link, doc } = resolved;

  const blobUrl = (doc as { blobUrl?: unknown }).blobUrl;
  if (typeof blobUrl !== "string" || !blobUrl) {
    return NextResponse.json({ error: "PDF not available" }, { status: 404 });
  }

  const sharePasswordHash = link.passwordHash;
  const sharePasswordSalt = link.passwordSalt;
  const passwordEnabled =
    typeof sharePasswordHash === "string" &&
    Boolean(sharePasswordHash) &&
    typeof sharePasswordSalt === "string" &&
    Boolean(sharePasswordSalt);

  if (passwordEnabled) {
    const cookieName = shareAuthCookieName(shareId);
    const cookie = getCookie(request, cookieName) ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: sharePasswordHash as string });
    if (!cookie || cookie !== expected) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  // Download permission is per link: the same document may be downloadable on one link and not on another.
  if (wantsDownload && !link.allowDownload) {
    return new Response("Download disabled", { status: 403 });
  }

  // Who is downloading. This route never asked, so an owner or a teammate downloading their own
  // deck bumped the link's `downloadCount`, moved its "Last viewed", and wrote "Someone downloaded
  // this · via Sequoia" into the owner's own activity feed — and, if it happened before the first
  // stats POST, created an unflagged `ShareView` row that counted as a recipient forever. The stats
  // ingest had been resolving the session for exactly this reason; these two paths had drifted.
  const downloadSession = wantsDownload ? await tryResolveAuthUserId(request) : null;
  const ownerPreview = wantsDownload
    ? await isOwnerSideViewer(doc as { orgId?: unknown; userId?: unknown }, downloadSession?.userId ?? null)
    : false;

  // Everything below this line is a write, and until now the only thing standing between a stranger
  // holding the link and the owner's analytics was the stranger's patience. This route is public,
  // unauthenticated and side-effecting: each `?download=1&botId=<anything>` upserts a `ShareView`
  // row, moves the link's counters and appends to the owner's activity feed, with the identity of
  // the "reader" taken straight from the query string — and `Range: bytes=0-0` made each invented
  // reader cost about a byte of egress. The stats ingest already bounded exactly this shape
  // (`sharestats:ip:<ip>`, see `/api/share/[shareId]/stats`); this route simply never got the same
  // bound.
  //
  // A blocked caller still receives their PDF. Refusing the bytes would turn a noisy-neighbour limit
  // into a broken download for whoever shares an office NAT with them; the only thing withheld is
  // the counter move.
  //
  // The key uses `clientIpFromRequest` rather than this file's `getClientIp`: the latter also honours
  // `cf-connecting-ip` / `true-client-ip`, which a direct caller sets freely and could therefore use
  // to mint a fresh bucket per request. `getClientIp` stays for analytics attribution only.
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

  // Best-effort download tracking (only when an explicit download is requested).
  if (trackDownload && trackingBotId) {
    try {
      const botIdHash = crypto.createHash("sha256").update(trackingBotId).digest("hex");
      const docId = (doc as { _id: unknown })._id;
      const docOrgId = (doc as { orgId?: unknown }).orgId;
      const day = utcDayKey(new Date());
      const dl = await ShareViewModel.updateOne(
        { shareId, botIdHash },
        {
          $setOnInsert: {
            shareId,
            docId,
            botIdHash,
            pagesSeen: [],
          },
          // `$set`, not `$setOnInsert`: an existing row (the common case) must also get the join
          // handle and the workspace, or it keeps a null one forever.
          $set: {
            shareLinkId: link._id,
            ...(docOrgId ? { orgId: new Types.ObjectId(String(docOrgId)) } : {}),
            ...(viewerIp ? { viewerIp } : {}),
            // Recorded, never counted — the same rule the stats ingest applies to owner views.
            isOwnerPreview: ownerPreview,
            // A download is real activity, so it moves "Last viewed" (see `ShareView.lastViewedAt`,
            // which exists because `updatedDate` is stamped by maintenance writes too).
            lastViewedAt: new Date(),
          },
          $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
        },
        { upsert: true },
      );
      // A `ShareView` row IS a view everywhere downstream (the per-link total counts rows), so a
      // download by a botId we have never seen has to move the same counters a first view does —
      // otherwise the document's counter reads lower than the sum of its links.
      if ((dl as { upsertedCount?: number })?.upsertedCount && !ownerPreview) {
        await DocModel.updateOne({ _id: docId }, { $inc: { numberOfViews: 1 } });
        void touchShareLink(shareId, "view", { countView: true });
      }
      // Per-link counters (best effort; the ShareView rows above stay the source of truth).
      if (!ownerPreview) void touchShareLink(shareId, "download");
    } catch (e) {
      // Ignore tracking failures (never block download).
      // If a duplicate key race occurs, retry once without upsert.
      try {
        const botIdHash = crypto.createHash("sha256").update(trackingBotId).digest("hex");
        const day = utcDayKey(new Date());
        await ShareViewModel.updateOne(
          { shareId, botIdHash },
          {
            $set: {
              shareLinkId: link._id,
              ...(viewerIp ? { viewerIp } : {}),
              isOwnerPreview: ownerPreview,
              lastViewedAt: new Date(),
            },
            $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
          },
        );
        // The retry used to increment `ShareView.downloads` and stop there, so the link's
        // `downloadCount` undercounted exactly the races it was meant to survive.
        if (!ownerPreview) void touchShareLink(shareId, "download");
      } catch {
        // ignore
      }
      void e;
    }
    // Runs on both paths: the activity feed must not lose a download to a duplicate-key race. The
    // owning side is the exception — "Someone downloaded this" about yourself is noise in your own
    // feed, and it is the same event the counters above already decline to count.
    if (!ownerPreview) {
      void recordDownloadActivity(
        doc as Record<string, unknown>,
        shareId,
        request,
        { linkLabel: link.label ?? null, isDefaultLink: Boolean(link.isDefault) },
        { userId: downloadSession?.userId ? String(downloadSession.userId) : null, botId: typeof botId === "string" ? botId : null },
      );
    }
  }

  // Range passes through untouched: pdf.js depends on it, and the limiter above only decided whether
  // this chunk counted, never whether it is served.
  const upstream = await fetch(blobUrl, {
    headers: rangeHeader ? { range: rangeHeader } : undefined,
    cache: "no-store",
  });

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

  // Share pages can be password protected; keep caching private.
  headers.set("cache-control", "private, max-age=3600");

  const filename = safePdfFilename(
    (doc as { fileName?: unknown }).fileName as string | null | undefined ??
      ((doc as { title?: unknown }).title as string | null | undefined),
  );
  headers.set("content-disposition", `${wantsDownload ? "attachment" : "inline"}; filename="${filename}"`);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}


