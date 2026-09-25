/**
 * Share stats ingest endpoint.
 *
 * Route:
 * - GET `/api/share/:shareId/stats` — owner-only aggregate stats (views/pagesViewed)
 * - POST `/api/share/:shareId/stats` — public, best-effort per-viewer tracking (views, pages, time)
 *
 * Also supports a lightweight "introduce yourself" payload (viewerName/viewerEmail) for anonymous viewers.
 */
import { NextResponse } from "next/server";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { recordActivity } from "@/lib/activity/log";
import crypto from "node:crypto";
import net from "node:net";
import { Types } from "mongoose";
import { DocModel } from "@/lib/models/Doc";
import { resolveShareLink, shareLinkUnlocked, touchShareLink, type PasswordProtectedLink } from "@/lib/share/links";
import { projectViewerKey, resolveProjectStatsTarget } from "@/lib/share/projectPublic";
import { resolveProjectLink } from "@/lib/share/projectLinks";
import { propagateViewerIdentity, viewerIdentityNews } from "@/lib/share/viewerIdentity";
import { sendViewerIntroductionEmails, viewerIntroductionAppUrl } from "@/lib/share/viewerIntroductionEmails";
import { isViewerEmailVerified } from "@/lib/share/viewerEmailVerification";
import { enqueueNotifications, notificationDedupeKey } from "@/lib/notifications/queue";
import { enqueueSlackPosts } from "@/lib/slack/outbox";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { ProjectLinkViewModel } from "@/lib/models/ProjectLinkView";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { isOwnerSideViewer } from "@/lib/share/ownerSide";
import { RECIPIENT_ONLY_MATCH } from "@/lib/analytics/shareViewAggregates";
import {
  countsAsPageRevisit,
  isPageExit,
  pageTimeIncrement,
  parseFlushReason,
  parsePageBound,
  parseTimingVersion,
  visitTimeIncrement,
} from "@/lib/analytics/shareTiming";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { after } from "next/server";
import { UserModel } from "@/lib/models/User";
import { clientIpFromRequest, rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";
import { scheduleVisitBrief } from "@/lib/visits/scheduleVisitBrief";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";

/**
 * Public ingest budget, per reader per minute.
 *
 * This was keyed on the bare IP, and that was wrong in a way that cost real data. A reader posts a
 * heartbeat every 30 seconds plus one per page turn, so a few per minute at rest and up to forty
 * when paging quickly. Share one bucket across an address and a data room opened by one deal team
 * behind one corporate egress exhausts it somewhere around three to twenty-four concurrent
 * readers, which is the ordinary case for the audience this product exists to serve.
 *
 * And a refusal was not a delay. The viewer posted fire-and-forget and `ReadingClock` clears its
 * ledger on handover, so a 429 destroyed that chunk's reading time, page dwell and exit page with
 * nothing logged. The owner saw analytics that were quietly wrong for exactly the audiences who
 * read the deck together.
 *
 * Keyed on the reader now, so colleagues cannot starve each other. The client retries a 429 as
 * well (`src/lib/share/statsBeacon.ts`), which is the half that matters: a limiter should shed
 * load, never eat data.
 */
const STATS_POST_LIMIT = 240;

/**
 * A wider ceiling on one address, because `botId` is the caller's to choose.
 *
 * The per-reader bucket above is the one that protects a legitimate audience; it protects nothing
 * against a single machine rotating the field. This is the abuse bound, set high enough that a
 * large office reading together never reaches it: fifty concurrent readers at the fast-paging rate
 * is about two thousand a minute.
 */
const STATS_POST_IP_LIMIT = 3_000;

/**
 * How many *first sightings of a new reader* one link may turn into mail in a day.
 *
 * `STATS_POST_LIMIT` bounds requests per address, which is the wrong unit for this: the expensive
 * thing is not a request, it is a request that creates a `ShareView` row nobody has seen before,
 * because each of those fans out to one queued email per member of the workspace. `botId` comes
 * from the caller, so a new one is free — rotate it per request and every single call is a brand
 * new reader, from any number of addresses.
 *
 * What an owner actually saw: a deck sent to twelve colleagues, and a stranger with the link
 * turning that into thousands of messages naming readers who do not exist, in twelve mailboxes.
 *
 * The ceiling is per link per day and deliberately generous — a genuine send to a large list is
 * well under it, and the number is about the tail, not the ordinary case. Past it the reading is
 * still recorded: the `ShareView` row is written, the metrics page still counts it, and only the
 * two fan-out side effects (the activity row and the mail) are skipped. Suppressing what the owner
 * is *told* while keeping what they can *look up* is the safe direction — the opposite would hide
 * real traffic.
 */
const NEW_VIEWER_FANOUT_PER_LINK_PER_DAY = 200;

/**
 * Confirmation mails one share link may cause in a day, counted across every address.
 * See the note at the send site — the sender's own bounds are per address, which an attacker
 * rotates freely, so this is the bound that actually holds.
 */
const VERIFY_MAIL_PER_LINK_PER_DAY = 50;

const STATS_POST_WINDOW_MS = 60 * 1000;
export const dynamic = "force-dynamic";
/**
 * As Non Empty String (uses trim).
 */


function asNonEmptyString(v: unknown, maxLen = 1024): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (s.length > maxLen) return null;
  return s ? s : null;
}

function normalizeViewerName(v: string): string | null {
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return null;
  // Bound storage + UI.
  return s.length > 80 ? s.slice(0, 80) : s;
}
/**
 * Pick First Forwarded Ip (uses trim, split).
 */


function pickFirstForwardedIp(v: string): string {
  // Often a comma-separated list: "client, proxy1, proxy2"
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
    return inside && net.isIP(inside) ? inside : null;
  }

  // Strip port for "1.2.3.4:5678"
  let ip = s;
  if (/^\d{1,3}(\.\d{1,3}){3}:\d+$/.test(s)) {
    ip = s.slice(0, s.lastIndexOf(":"));
  }

  // Only ever store a real IP literal (proxy headers are client-influenced text).
  return net.isIP(ip) ? ip : null;
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
 * Normalize Email (uses toLowerCase, trim, includes).
 */


function normalizeEmail(v: string): string | null {
  const s = v.trim().toLowerCase();
  if (!s) return null;
  // Very basic sanity check (we don't need strict RFC validation here).
  if (!s.includes("@") || s.startsWith("@") || s.endsWith("@")) return null;
  return s;
}
/**
 * As Duration Ms (clamped).
 */
function asDurationMs(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const ms = Math.floor(n);
  if (ms < 1) return null;
  // Cap to 24h to prevent abuse / broken clocks.
  return Math.min(ms, 24 * 60 * 60 * 1000);
}

/**
 * As Epoch Ms (clamped).
 */
function asEpochMs(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const ms = Math.floor(n);
  // Guardrails: reject tiny/negative and absurdly future timestamps.
  if (ms < 946684800000) return null; // 2000-01-01
  if (ms > Date.now() + 10 * 60 * 1000) return null; // allow a bit of clock skew
  return ms;
}
/**
 * Handle GET requests.
 */


export async function GET(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  return withMongoRequestLogging(request, async () => {
    try {
      const { shareId } = await ctx.params;
      if (!shareId) {
        return NextResponse.json({ error: "Missing shareId" }, { status: 400 });
      }

      // Perf: avoid minting temp users for public share stats reads.
      const session = await tryResolveAuthUserId(request);

      // Resolve through the link so a disabled/expired link stops answering, like the share page.
      const resolved = await resolveShareLink(shareId, {
        select: { title: 1 } as Record<string, 1>,
      });
      // A project link's slug resolves to no document (`resolveShareLink` refuses it by design), so
      // the overlay has to name the document being read. Scoping the counts by it matters: without
      // the `docId` clause every document in a data room would report the whole link's traffic.
      /**
       * A locked data room answers the same thing about every document id, member or not.
       *
       * `resolveProjectStatsTarget` resolves the link and the document together, so on a room the
       * caller had no password for, a guessed id was sorted into "inside" (the locked answer) and
       * "outside" (404) before the gate: an inventory of the room, handed out by the one thing the
       * password withholds (docs/SECURITY.md 7.8). So the link is resolved on its own first, the
       * gate runs on it, and only then is the document looked up. The membership lookup does not
       * run for a locked room at all, so it cannot be timed either.
       */
      if (!resolved) {
        const roomLink = await resolveProjectLink(shareId);
        if (!roomLink || roomLink.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
        if (!shareLinkUnlocked(request, shareId, roomLink.link as PasswordProtectedLink)) {
          return NextResponse.json({ isOwner: false }, { headers: { "cache-control": "no-store" } });
        }
      }
      const projectTarget = resolved
        ? null
        : await resolveProjectStatsTarget({ shareId, request, select: { userId: 1, orgId: 1 } as Record<string, 1> });
      if ((!resolved || resolved.refusal) && (!projectTarget || projectTarget.refusal)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const link = resolved ? resolved.link : projectTarget!.link;
      // A locked link answers nothing about itself until the password has been given — the same
      // rule the share page itself runs, which has no owner exemption either (`/s/[shareId]`
      // renders `PasswordGate` for anyone without the cookie, owner included). So the overlay is
      // only ever read from a page that already passed the gate, and the check costs a real
      // recipient nothing. Answered with the same `{ isOwner: false }` a stranger gets rather than
      // a 404: the viewer's `loadContext` treats it as "no overlay", not as a broken link.
      if (!shareLinkUnlocked(request, shareId, link as PasswordProtectedLink)) {
        return NextResponse.json({ isOwner: false }, { headers: { "cache-control": "no-store" } });
      }
      const doc = (resolved ? resolved.doc : projectTarget!.doc) as { _id?: unknown; userId?: unknown };
      const docScope = projectTarget ? { docId: projectTarget.doc._id } : {};

      const isOwner = Boolean(session?.userId) && String(doc.userId) === String(session?.userId);
      if (!isOwner) {
        return NextResponse.json({ isOwner: false }, { headers: { "cache-control": "no-store" } });
      }

      // This endpoint's whole address is one link, so it answers for that link. It used to return
      // `Doc.numberOfViews` / `Doc.numberOfPagesViewed` — document-wide sums across every link —
      // and the owner overlay then cached them under a per-shareId key, so a quiet second link
      // reported the busy link's traffic. Same definitions as the owner metrics route.
      // `RECIPIENT_ONLY_MATCH`, like the metrics route: this overlay is read by the owner while
      // they are looking at their own share page, which is the single most reliable way to
      // manufacture the owner-preview rows it must not count.
      const [views, pagesAgg] = await Promise.all([
        ShareViewModel.countDocuments({ shareId, ...docScope, ...RECIPIENT_ONLY_MATCH }),
        ShareViewModel.aggregate([
          { $match: { shareId, ...docScope, ...RECIPIENT_ONLY_MATCH } },
          { $group: { _id: null, pagesSeenArrays: { $push: { $ifNull: ["$pagesSeen", []] } } } },
          {
            $project: {
              _id: 0,
              pagesViewed: {
                $size: { $reduce: { input: "$pagesSeenArrays", initialValue: [], in: { $setUnion: ["$$value", "$$this"] } } },
              },
            },
          },
        ]) as Promise<Array<{ pagesViewed?: number }>>,
      ]);
      const pagesViewed =
        pagesAgg[0] && typeof pagesAgg[0].pagesViewed === "number" && Number.isFinite(pagesAgg[0].pagesViewed)
          ? pagesAgg[0].pagesViewed
          : 0;

      return NextResponse.json(
        { isOwner: true, stats: { views, pagesViewed } },
        { headers: { "cache-control": "no-store" } },
      );
    } catch (err) {
      // A fixed message to an anonymous caller; the real one goes to the log.
      return errorJson(err, { status: 500, publicMessage: "Something went wrong", context: "[api/share/:shareId/stats] GET failed" });
    }
  });
}
/**
 * Handle POST requests.
 */


export async function POST(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  return withMongoRequestLogging(request, async () => {
    try {
      const { shareId } = await ctx.params;
      if (!shareId) {
        return NextResponse.json({ error: "Missing shareId" }, { status: 400 });
      }

      const body = (await request.json().catch(() => ({}))) as unknown;
      const botId = asNonEmptyString((body as { botId?: unknown })?.botId);
      /**
       * Bounded like every other page field on this payload (`toPage`, `numPages`), which it was
       * not: the old parser floored anything numeric and accepted it as long as it was >= 1, so a
       * caller could post `pageNumber: 9e15`. Each distinct value is a new entry in the row's
       * `pagesSeen` and a new key under `pageTimeMsByPage` / `pageVisitCountByPage`, and those are
       * Map fields on ONE analytics document — enough of them and the row passes Mongo's 16MB
       * limit, at which point every further write to that viewer fails and the owner's stats
       * overlay for the link stops loading. 1..5000 is the same ceiling `parsePageBound` already
       * imposed on the neighbouring fields, and it is the only bound — narrowing to the document's
       * own page count was tried and reverted, for the reason recorded at `pageNumber` below.
       */
      const pageNumberRaw = parsePageBound((body as { pageNumber?: unknown })?.pageNumber);
      const durationMs = asDurationMs((body as { durationMs?: unknown })?.durationMs);
      /**
       * Time on the *current page*, which is a different interval from `durationMs` and must never
       * be derived from it. The viewer runs two clocks — one for the visit, one for the page — and
       * they start at different moments; crediting the visit chunk to the page double counted both
       * totals, because the page's own segment arrived again on the next page turn. See the
       * `flushTime` comment in `PdfJsViewer`.
       */
      const pageDurationMs = asDurationMs((body as { pageDurationMs?: unknown })?.pageDurationMs);
      const visitId = asNonEmptyString((body as { visitId?: unknown })?.visitId, 256);
      const enteredAtMs = asEpochMs((body as { enteredAtMs?: unknown })?.enteredAtMs);
      const leftAtMs = asEpochMs((body as { leftAtMs?: unknown })?.leftAtMs);
      // Reading-clock fields (`src/lib/share/readingClock.ts`); all absent from older viewers.
      const timingVersion = parseTimingVersion((body as { tv?: unknown })?.tv);
      const flushReason = parseFlushReason((body as { reason?: unknown })?.reason);
      const toPage = parsePageBound((body as { toPage?: unknown })?.toPage);
      const numPages = parsePageBound((body as { numPages?: unknown })?.numPages);
      const viewerEmailRaw = asNonEmptyString((body as { viewerEmail?: unknown })?.viewerEmail);
      const viewerEmail = viewerEmailRaw ? normalizeEmail(viewerEmailRaw) : null;
      /** This post is the act of introducing, not a heartbeat replaying a stored profile. */
      const introducedNow = (body as { introduced?: unknown })?.introduced === true;
      const viewerNameRaw = asNonEmptyString((body as { viewerName?: unknown })?.viewerName, 160);
      const viewerNameIntro = viewerNameRaw ? normalizeViewerName(viewerNameRaw) : null;
      if (!botId) {
        return NextResponse.json({ error: "Missing botId" }, { status: 400 });
      }

      /**
       * Two buckets, and the order matters.
       *
       * The reader's own budget is checked first and is the one an honest recipient can reach, so
       * it is the one that must not be shared with their colleagues. The address bucket sits behind
       * it as the abuse bound, wide enough that a floor of people reading the same room never
       * touches it.
       *
       * Both keys use only proxy-set headers (`x-forwarded-for` first hop / `x-real-ip`):
       * `getClientIp` also honours `cf-connecting-ip` / `true-client-ip`, which a direct caller
       * could set to rotate buckets. Keep that one for analytics attribution only.
       */
      const readerKey = crypto.createHash("sha256").update(botId).digest("hex").slice(0, 32);
      const rl = await rateLimit({
        key: `sharestats:reader:${readerKey}`,
        limit: STATS_POST_LIMIT,
        windowMs: STATS_POST_WINDOW_MS,
      });
      if (!rl.ok) return rateLimitedResponse(rl);
      const ipRl = await rateLimit({
        key: `sharestats:ip:${clientIpFromRequest(request)}`,
        limit: STATS_POST_IP_LIMIT,
        windowMs: STATS_POST_WINDOW_MS,
      });
      if (!ipRl.ok) return rateLimitedResponse(ipRl);

      // Views are recorded against the link that was opened; a refused link records nothing.
      // `slideNodes.pageNumber` used to ride along here as the document's real page count, to narrow
      // `pageNumber` below. That narrowing is gone (see the note at `pageNumber`), so the projection
      // went with it: it is one subdocument per page pulled out of Mongo on every 30-second
      // heartbeat of every open viewer, for a value nothing reads.
      const resolved = await resolveShareLink(shareId, { select: { title: 1 } as Record<string, 1> });
      /**
       * The project-link path (PRD decision 5). `resolveShareLink` returns null for a project
       * slug by design, so only then do we ask which document of that project is being read — from
       * the body if a client sends it, otherwise from the `/p/:shareId/:docId` page that made the
       * request (`resolveProjectStatsTarget`, which re-proves the document is in the project).
       * Everything below this point is the same code the document path runs; that is the whole
       * bargain of decision 5 — reading time, sessions and page sequences with no new timing code.
       */
      // The room's link first, then its gate, then the document: see the note on the GET above.
      // A locked room answers the same quiet 200 as the locked write below, for every id.
      if (!resolved) {
        const roomLink = await resolveProjectLink(shareId);
        if (!roomLink || roomLink.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
        if (!shareLinkUnlocked(request, shareId, roomLink.link as PasswordProtectedLink)) {
          return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
        }
      }
      const projectTarget = resolved
        ? null
        : await resolveProjectStatsTarget({ shareId, request, bodyDocId: (body as { docId?: unknown })?.docId, select: { title: 1, userId: 1, orgId: 1 } as Record<string, 1> });
      if ((!resolved || resolved.refusal) && (!projectTarget || projectTarget.refusal)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const link = resolved ? resolved.link : projectTarget!.link;
      /**
       * A locked link ingests nothing until the password has actually been given.
       *
       * This used to be the project branch only, on the reasoning that the document ingest had
       * always accepted a view on a locked `/s/:shareId`. It had, and that was the bug: this route
       * is public and `resolveShareLink` says nothing about the password (it computes `refusal`
       * from archived/disabled/expired alone), so anyone holding a forwarded slug could POST a
       * view, a page and — worse than a number — an `introduced: true` name and email of their
       * choosing, which lands in the owner's activity feed as a named reader and is mailed to the
       * whole workspace as fact. A password on a link is the owner saying the URL is not enough;
       * an analytics row that only a URL was needed to write breaks that promise as surely as
       * serving the PDF would.
       *
       * One unconditional call covers both branches: `shareLinkUnlocked` returns true for a link
       * with no password, so the guard cannot be acquired by forgetting the `if`, and it reads the
       * cookie off the raw request (no `await cookies()` needed here).
       *
       * Answered 200 with no write, never 401, for the same reason as `POST
       * /api/share/:shareId/landing`: a recipient whose browser refuses the cookie must see a
       * quiet no-op, not an error in the console of a page that is otherwise working.
       */
      if (!shareLinkUnlocked(request, shareId, link as PasswordProtectedLink)) {
        return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
      }
      const doc = (resolved ? resolved.doc : projectTarget!.doc) as Record<string, unknown> & { _id: unknown; orgId?: unknown };
      /**
       * The page this POST claims to be about. Its only bound is the 1..5000 parse above.
       *
       * A second narrowing — to the document's own page count, from `docPageCount(doc.slideNodes)`
       * — was written here and removed, and the comment that described it as live outlived it by a
       * commit. It is not coming back in that form: `Doc.slideNodes` is a render artifact, and when
       * a replacement upload's slide pass fails the *previous* version's nodes are deliberately kept
       * while `blobUrl` moves on to the new file (see `finalSlideNodes` in
       * `/api/uploads/:uploadId/process`). A 9-page v1 then sits on a 30-page v2, recipients read
       * the 30-page PDF, and every genuine reading past page 9 was being discarded — no `pagesSeen`,
       * no heatmap, no "read to page N" in the owner's mail. Silently dropping real readings is a
       * worse failure than the one the narrowing was added for.
       *
       * The finding it was added for was that `pageNumber` was *unbounded*: each distinct value is
       * an entry in the row's `pagesSeen` and a key under `pageTimeMsByPage` / `pageVisitCountByPage`
       * — Map fields on one analytics document, which stops accepting writes at Mongo's 16MB limit.
       * `parsePageBound` is that bound, and it is the same one `toPage` and `numPages` get.
       */
      const pageNumber = pageNumberRaw;
      const shareLinkId = link._id;
      // Denormalized tenancy on the analytics rows (see `ShareView.orgId`).
      const shareOrgId = doc.orgId ? new Types.ObjectId(String(doc.orgId)) : null;

      // Perf: return immediately; analytics updates are best-effort.
      const docId = doc._id;
      const viewerIp = getClientIp(request);
      const session = await tryResolveAuthUserId(request);
      const viewerUserId =
        session?.userId && Types.ObjectId.isValid(session.userId) ? new Types.ObjectId(session.userId) : null;
      /** The person. Used for the `ProjectLinkView` row, which is about who came, not what they read. */
      const viewerBotIdHash = crypto.createHash("sha256").update(botId).digest("hex");
      /**
       * The analytics key the `ShareView` / `ShareVisit` rows are written under. On a document link
       * it is the bare digest, as it always was. On a project link it carries the document too, so
       * one recipient reading three documents behind one slug produces three rows instead of
       * colliding on the unique `{shareId, botIdHash}` index and merging their page numbers — see
       * `projectViewerKey` for the full reasoning and what it costs.
       */
      const botIdHash = projectTarget ? projectViewerKey(viewerBotIdHash, String(docId)) : viewerBotIdHash;
      const visitIdHash = visitId ? crypto.createHash("sha256").update(visitId).digest("hex") : null;

      after(async () => {
        try {
          const setFields: Record<string, unknown> = {};
          if (viewerIp) setFields.viewerIp = viewerIp;
          if (viewerUserId) setFields.viewerUserId = viewerUserId;
          if (viewerEmail) setFields.viewerEmail = viewerEmail;
          // Anonymous-only: allow "introduce yourself" name/email snapshots.
          if (!viewerUserId && viewerNameIntro) setFields.viewerName = viewerNameIntro;
          if (!viewerUserId && viewerEmail) setFields.viewerEmailSnapshot = viewerEmail;
          // `shareLinkId` / `orgId` are `$set`, not `$setOnInsert`: a row that already existed when
          // the link was materialised would otherwise keep a null join handle forever, and the
          // returning viewer who matches that row never gives us another chance to fill it.
          setFields.shareLinkId = shareLinkId;
          if (shareOrgId) setFields.orgId = shareOrgId;
          // The one write that means "someone read this". `updatedDate` cannot carry it: Mongoose
          // stamps that on every update query, so a backfill or a metrics-page read moved it too
          // and "Last viewed" reported the maintenance instant (see `ShareView.lastViewedAt`).
          // Held in a local because the notification queued below records the same instant as its
          // `occurredAt`, and a digest that sorts on a second reading of the clock is a digest
          // whose order drifts from the analytics it is reporting.
          const viewedAt = new Date();
          setFields.lastViewedAt = viewedAt;
          // Recorded, not counted: the owner's own opens stay visible to anyone debugging a link
          // and stay out of every figure the owner reads (`RECIPIENT_ONLY_MATCH`). `$set` on every
          // heartbeat, so a row first written while signed out self-heals once they sign in.
          const ownerPreview = await isOwnerSideViewer(doc as Record<string, unknown>, viewerUserId);
          setFields.isOwnerPreview = ownerPreview;

          /**
           * Before the upsert, because the upsert is what would make it look like old news.
           *
           * Gated on `introduced`, which the viewer sets only on the post that carries a *fresh*
           * introduction. Every heartbeat after it replays the same stored profile, and asking on
           * each of those would put two indexed reads on the busiest write path in the product for
           * an answer that is "no" every time. The client only chooses *when to ask*; the check
           * below still decides whether it is news, so a client that lies gets nothing.
           */
          const identityNews =
            introducedNow && !viewerUserId && (viewerNameIntro || viewerEmail)
              ? await viewerIdentityNews({
                  shareId,
                  botIdHash,
                  orgId: shareOrgId ? String(shareOrgId) : null,
                  name: viewerNameIntro,
                  email: viewerEmail,
                })
              : { isNew: false, changed: false };

          // The upsert is the write most likely to throw: two first-time POSTs for the same
          // (shareId, botIdHash) race and the unique index makes the loser fail with E11000. That
          // used to abort the whole analytics block — losing this heartbeat's pages and time too —
          // because the outer catch swallowed it. A duplicate key just means "the row exists".
          let created = false;
          /**
           * The `_id` of the row this POST inserted, and the identity the notification's
           * `dedupeKey` is built from — one reading, one email owed, whatever replays this request.
           * Only ever set on the insert; a returning viewer's heartbeat leaves it null because it
           * owes nothing new.
           */
          let createdShareViewId: Types.ObjectId | null = null;
          /**
           * The reading's time rides along on this upsert rather than in a write of its own.
           *
           * One heartbeat used to touch this document three times: here, again to add the page, and
           * again to add the milliseconds. All three carry `lastViewedAt`/`updatedDate`, and
           * `shareviews` has six indexes across those two fields, so the index churn was paid three
           * times for one reading. The clocks are still separate (`@/lib/analytics/shareTiming.ts`
           * holds those rules); only the write is shared.
           */
          const timingInc: Record<string, number> = {};
          {
            const timing = { durationMs, pageDurationMs, enteredAtMs, leftAtMs };
            const visitMs = visitTimeIncrement(timing);
            const pageMs = pageNumber ? pageTimeIncrement(timing) : null;
            if (visitMs) timingInc.timeSpentMs = visitMs;
            if (pageNumber && pageMs) timingInc[`pageTimeMsByPage.${String(pageNumber)}`] = pageMs;
          }
          const viewUpdate = {
            $setOnInsert: {
              shareId,
              docId,
              botIdHash,
              pagesSeen: [],
            },
            $set: setFields,
            ...(Object.keys(timingInc).length ? { $inc: timingInc } : {}),
          };
          try {
            const upsert = await ShareViewModel.updateOne({ shareId, botIdHash }, viewUpdate, { upsert: true });
            created = Boolean((upsert as any)?.upsertedCount);
            const upsertedId = (upsert as { upsertedId?: unknown } | null)?.upsertedId;
            createdShareViewId =
              created && upsertedId && Types.ObjectId.isValid(String(upsertedId))
                ? new Types.ObjectId(String(upsertedId))
                : null;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/E11000|duplicate key/i.test(msg)) throw e;
            /**
             * Two first-time POSTs for the same (shareId, botIdHash) raced and the unique index
             * failed the loser. The row exists, so the insert is not wanted, but everything else in
             * this update still is: before, the catch simply swallowed and this heartbeat's
             * `lastViewedAt`, viewer identity and now its milliseconds went on the floor. Rare, and
             * silent, which is the combination worth removing.
             */
            try {
              await ShareViewModel.updateOne({ shareId, botIdHash }, {
                $set: setFields,
                ...(Object.keys(timingInc).length ? { $inc: timingInc } : {}),
              });
            } catch {
              // The retry is best effort; losing it costs one heartbeat, not the request.
            }
          }

          /**
           * Charged once per brand-new reader, never on a repeat visit by someone already known,
           * so an ordinary audience never touches it however often they come back.
           *
           * The charge cannot hang off `created` alone. On a document link a row is one viewer, but
           * on a project link a row is one (viewer, document) — so a ten-file data room sent to
           * forty investors charged the budget four hundred times, spent it after the twentieth
           * investor, and then stopped telling the owner about the twenty real people who came
           * after. The extra `limit: 1` bucket is a per-day dedupe on the *person*: it answers
           * "have we already charged for this reader today", so ten files cost one.
           */
          const firstSightingToday =
            created &&
            (
              await rateLimit({
                key: `viewfanseen:${shareId}:${viewerBotIdHash}`,
                limit: 1,
                windowMs: 24 * 60 * 60 * 1000,
              })
            ).ok;
          const fanOutAllowed = firstSightingToday
            ? (
                await rateLimit({
                  key: `viewfanout:${shareId}`,
                  limit: NEW_VIEWER_FANOUT_PER_LINK_PER_DAY,
                  windowMs: 24 * 60 * 60 * 1000,
                })
              ).ok
            : true;

          if ((identityNews.isNew || identityNews.changed) && !ownerPreview && shareOrgId && fanOutAllowed) {
            void recordActivity({
              orgId: String(shareOrgId),
              userId: null,
              actorKind: "viewer",
              type: "viewer.introduced",
              docId: String(docId),
              projectId: projectTarget ? String(projectTarget.project._id) : null,
              title: typeof (doc as any)?.title === "string" ? String((doc as any).title) : null,
              meta: {
                changed: identityNews.changed,
                // The person, so the feed can link their name to their reader page — and so a name
                // given later renames this row too (the `viewerKey` join in /api/activity).
                viewerKey: botIdHash,
                authenticated: Boolean(viewerUserId),
                viewerName: viewerNameIntro,
                viewerEmail: viewerEmail,
                shareId,
                linkLabel: link.label ?? null,
                isDefaultLink: Boolean(link.isDefault),
                ...(projectTarget
                  ? {
                      projectName:
                        typeof projectTarget.project.name === "string" ? projectTarget.project.name : null,
                    }
                  : null),
              },
              request,
            });
            await enqueueSlackPosts({
              orgId: String(shareOrgId),
              kind: "views",
              sourceId: `intro:${shareId}:${botIdHash}`,
              event: { docId: String(docId), projectId: projectTarget ? String(projectTarget.project._id) : null, shareId, viewerKey: botIdHash, viewerName: viewerNameIntro ?? null, viewerEmail: viewerEmail ?? null, introduced: true },
            });
          }

          /**
           * A returning recipient is recognised from their browser's local storage, so they are
           * only asked to introduce themselves once — which means a *corrected* name would land on
           * this one row and nowhere else, and the owner would meet the same reader under two
           * names on two pages. Write it through to the rest of this person's rows in this
           * workspace. The realtime server watches these two fields, so an open metrics page
           * updates itself from the same write (see `propagateViewerIdentity`).
           */
          // Gated on the same answer the event is: the viewer replays its stored profile on every
          // heartbeat, and a rewrite that changes nothing still costs two collection-wide updates
          // and — because the realtime server watches exactly these two fields — a frame per row
          // it touches, to every open metrics page in the workspace.
          if ((identityNews.isNew || identityNews.changed) && !viewerUserId && (viewerNameIntro || viewerEmail)) {
            /**
             * Has this workspace ever had a confirmed click for this address?
             *
             * Nothing on this request proves the address is the caller's — it is a string in a
             * public POST body — so this is the only thing that separates "a reader told us who
             * they are" from "a stranger holding the link typed a real person's name". The answer
             * decides how far `propagateViewerIdentity` writes it; see `identityFanOutScope`.
             * A lookup that throws is treated as unverified, which narrows the write.
             */
            const emailVerified = viewerEmail && shareOrgId
              ? await isViewerEmailVerified(shareOrgId, viewerEmail).catch(() => false)
              : false;
            try {
              await propagateViewerIdentity({
                shareId,
                botIdHash,
                orgId: shareOrgId ?? null,
                name: viewerNameIntro,
                email: viewerEmail,
                emailVerified,
              });
            } catch {
              // best-effort: the row this heartbeat wrote already carries the new identity.
            }

            /**
             * And now actually send the mail an introduction owes.
             *
             * What went wrong: `sendViewerIntroductionEmails` — the confirmation link to the
             * reader, and the correction to the members who were already told about them
             * anonymously — was written, tested and then never called from anywhere. Its own doc
             * comment said it was called "from the two routes that can receive an introduction";
             * neither route imported it. So the address on the row was accepted as fact and the
             * only control that could ever turn it into a *proved* address was dead code, which is
             * also why `/share/verify` was reachable only by a token nothing minted.
             *
             * Gated on the same answer the fan-out above is, plus the two gates this specific side
             * effect needs: `!ownerPreview` (an owner testing their own link mails nobody) and
             * `fanOutAllowed` (the per-link daily ceiling that already bounds the "new reader"
             * mail, for the same reason — `botId` is the caller's and a fresh one is free).
             *
             * Awaited, not `void`-ed: this whole block is inside `after()`, which keeps the lambda
             * alive only for work it is awaiting. The function never throws by contract.
             */
            if (viewerEmail && !ownerPreview && shareOrgId && fanOutAllowed) {
              const appUrl = viewerIntroductionAppUrl();
              /**
               * A ceiling on confirmation mail per link, whatever address it is addressed to.
               *
               * The sender's own bounds are keyed on the address — three per address per workspace,
               * one an hour — which is the right shape for someone who mistypes their own address
               * and the wrong shape entirely for an attacker, who simply supplies a new one each
               * time and is never the same key twice. `fanOutAllowed` does not cover it either: it
               * is charged only when a `ShareView` row is *created*, so holding `botId` steady and
               * rotating only the address makes every request after the first free.
               *
               * Wiring this previously-dead sender into a public, unauthenticated route without
               * that second bound would have made the product an arbitrary-recipient mail relay —
               * anyone with a live share link could have it email anyone they liked, from our own
               * sending domain. That is a deliverability incident as much as an abuse one.
               *
               * So it is bounded by the thing the caller cannot rotate: the link. Degrades rather
               * than refuses — the introduction is still accepted, recorded and shown in the feed.
               */
              const mailBudget = await rateLimit({
                key: `viewerverify:${shareId}`,
                limit: VERIFY_MAIL_PER_LINK_PER_DAY,
                windowMs: 24 * 60 * 60 * 1000,
              });
              // No absolute base configured in production means a relative link, and a relative
              // link in a mail client does nothing — so there is no confirmation to offer.
              if (appUrl && mailBudget.ok) {
                await sendViewerIntroductionEmails({
                  orgId: shareOrgId,
                  shareId,
                  // The PERSON: never `botIdHash`, which on a project link carries the document
                  // suffix. The token is about a reader, not about a reader-and-a-file.
                  viewerKey: viewerBotIdHash,
                  email: viewerEmail,
                  name: viewerNameIntro,
                  documentTitle: typeof (doc as any)?.title === "string" ? String((doc as any).title) : null,
                  // The same shape `buildMetricsUrl` produces, inlined rather than imported: the
                  // module it lives in is the notification email pipeline, and pulling that onto
                  // this route's cold start for one string is not a trade the busiest write path
                  // in the product should make.
                  metricsUrl: `${appUrl}/doc/${encodeURIComponent(String(docId))}/metrics?shareId=${encodeURIComponent(shareId)}`,
                  appUrl,
                });
              }
            }
          }

          // The link's `lastViewedAt` moves for every view, not only a first-time viewer's: a
          // recipient who comes back daily used to leave the links table reading "Never". An owner
          // preview moves nothing: "Last viewed 2 minutes ago" on a link nobody has received yet is
          // the same lie as counting the view.
          //
          // On a document link `created` *is* "a new recipient", because a row is one viewer. On a
          // project link a row is one (viewer, document), so `created` fires again for the second
          // file the same investor opens and the stored counter climbed past the recipient count
          // every read path reports. The project answer comes from the `ProjectLinkView` upsert
          // below — that collection is keyed on (link, viewer) and is the only place that knows
          // whether this landing is a new person — so the touch is deferred to after it.
          if (!ownerPreview && !projectTarget) void touchShareLink(shareId, "view", { countView: created });

          // "Which documents did this person open through this link" (PRD decision 6) is recorded
          // here, from the rendered viewer, rather than from a click handler on the project page: a
          // click can be lost to the navigation it causes, and a deep link into `/p/:shareId/:docId`
          // never passes through the page at all. The row is upserted rather than updated for
          // exactly that second case — a recipient can arrive at a document without ever landing.
          if (projectTarget) {
            /** Whether this landing created the (link, viewer) row, i.e. a recipient not seen before. */
            let newProjectViewer = false;
            try {
              const res = await ProjectLinkViewModel.updateOne(
                { shareId, botIdHash: viewerBotIdHash },
                {
                  $setOnInsert: {
                    shareId,
                    projectId: projectTarget.project._id,
                    botIdHash: viewerBotIdHash,
                    firstViewedAt: new Date(),
                  },
                  $set: {
                    shareLinkId,
                    ...(projectTarget.project.orgId ? { orgId: projectTarget.project.orgId } : {}),
                    ...(viewerIp ? { viewerIp } : {}),
                    ...(viewerUserId ? { viewerUserId } : {}),
                    isOwnerPreview: ownerPreview,
                    lastViewedAt: new Date(),
                    // The introduction was in scope here and never copied across, so a visitor who
                    // gave their name inside a data-room document stayed anonymous on the row that
                    // says they came — the one row the room's own figures are keyed on.
                    ...(!viewerUserId && viewerNameIntro ? { viewerName: viewerNameIntro } : {}),
                    ...(!viewerUserId && viewerEmail ? { viewerEmailSnapshot: viewerEmail } : {}),
                  },
                  $addToSet: { docsOpened: new Types.ObjectId(String(docId)) },
                },
                { upsert: true },
              );
              newProjectViewer = Boolean((res as { upsertedCount?: number } | null)?.upsertedCount);
            } catch (e) {
              const msg = e instanceof Error ? e.message : String(e);
              // A duplicate key means the row was already there, so this is not a new recipient.
              if (!/E11000|duplicate key/i.test(msg)) throw e;
            }
            // Same contract as the document branch above: the timestamp moves on every recipient
            // read, the counter only on a new recipient.
            if (!ownerPreview) void touchShareLink(shareId, "view", { countView: newProjectViewer });
          }

          if (created && !ownerPreview) {
            // A read through a project link is the **project's** view, not the document's
            // (docs/METRICS.md, `@/lib/analytics/docScope`): the document's own figures exclude it
            // on every surface, so its counter must not be bumped either. Incrementing it here was
            // the last place the old rule survived — the metrics route subtracted the project's
            // slugs while this kept adding them, and `Doc.numberOfViews` ended up above the number
            // the document's own page could ever show. The activity feed below still records the
            // view: the read happened, it is just the data room's.
            if (!projectTarget) await DocModel.updateOne({ _id: docId }, { $inc: { numberOfViews: 1 } });
            // Activity feed: one "viewed" event per new viewer of this share (not per page/visit),
            // and the notification rows that reading owes.
            //
            // Awaited rather than `void`-ed: everything here already runs inside `after()`, so the
            // response has gone out and nothing is waiting on it — but `after()` only keeps the
            // lambda alive for work it is awaiting, and a fire-and-forget insert on the busiest
            // write path in the product is one a freeze can drop. The block still swallows its own
            // errors, so the best-effort contract is unchanged.
            await (async () => {
              try {
                const ownerUserId = (doc as any)?.userId ? new Types.ObjectId(String((doc as any).userId)) : null;
                const docOrgId = (doc as any)?.orgId
                  ? String((doc as any).orgId)
                  : ownerUserId
                    ? String((await ensurePersonalOrgForUserId({ userId: ownerUserId })).orgId)
                    : null;
                if (!docOrgId) return;
                await recordActivity({
                  orgId: docOrgId,
                  userId: viewerUserId ? String(viewerUserId) : null,
                  actorKind: "viewer",
                  type: "share.viewed",
                  docId: String(docId),
                  // A reading inside a data room belongs to the room as well as the document. It was
                  // already in `meta`; on the row it also survives the project being renamed, and
                  // lets the feed be filtered by project like every other project event.
                  projectId: projectTarget ? String(projectTarget.project._id) : null,
                  title: typeof (doc as any)?.title === "string" ? String((doc as any).title) : null,
                  meta: {
                    authenticated: Boolean(viewerUserId),
                    // Viewer key (sha256 of the browser's botId): lets the feed show the name a recipient
                    // gives after this row was written (see src/app/api/activity/route.ts).
                    viewerKey: botIdHash,
                    viewerName: viewerNameIntro ?? null,
                    viewerEmail: viewerEmail ?? null,
                    shareId,
                    // Which link they came through: the feed renders "via Sequoia" and skips the
                    // suffix for the default link (see `linkSuffix` in src/lib/activity/labels.ts).
                    linkLabel: link.label ?? null,
                    isDefaultLink: Boolean(link.isDefault),
                    // Project links only: which data room the document was opened inside.
                    ...(projectTarget
                      ? {
                          projectId: String(projectTarget.project._id),
                          projectName: typeof projectTarget.project.name === "string" ? projectTarget.project.name : null,
                        }
                      : null),
                  },
                  request,
                });

                /**
                 * The mail this reading owes, written down here rather than rediscovered at the
                 * next tick (PRD decision 1). Same block and same condition as the activity row
                 * above — `created && !ownerPreview` — because "a new recipient opened this" is the
                 * event both of them are about.
                 *
                 * Fan-out to the whole workspace happens now, one row per member, so a retry, a
                 * preference and a failure are all per recipient. `viewEmailMode` is deliberately
                 * NOT read here (decision 2): resolving it at send is what lets a member who turns
                 * view emails on today hear about the readings from yesterday, which the cursor
                 * model could never do.
                 */
                if (createdShareViewId && fanOutAllowed) {
                  const members = (await OrgMembershipModel.find({
                    orgId: new Types.ObjectId(docOrgId),
                    isDeleted: { $ne: true },
                  })
                    .select({ userId: 1 })
                    .lean()) as Array<{ userId?: unknown }>;
                  // Awaited, unlike the `void` on `recordActivity` above, and the difference
                  // matters here: this whole block runs inside `after()`, which keeps the lambda
                  // alive only for work it is awaiting. An un-awaited insert on the busiest write
                  // path in the product is one a freeze can cut off mid-flight — and losing this
                  // row is not losing a feed entry, it is losing the email, which is the exact
                  // failure the queue exists to remove.
                  // One insert for the whole workspace, not one per member. This was a
                  // `Promise.all` over `enqueueNotification`, which is a `create` and a unique-index
                  // probe each: a thirty-member workspace cost thirty round trips per new reader,
                  // and a two-hundred-person send into it cost six thousand, all here inside
                  // `after()`. The event is identical for every member; only the recipient differs.
                  const event = {
                    docId: String(docId),
                    projectId: projectTarget ? String(projectTarget.project._id) : null,
                    shareId,
                    // The PERSON, so `viewerBotIdHash` and never `botIdHash` (decision 9): on a
                    // project link the latter is the `<digest>.<docId>` composite, and the document
                    // already has its own field on the row. Three bugs this month came from those
                    // two shapes being compared literally.
                    viewerKey: viewerBotIdHash,
                    viewerName: viewerNameIntro ?? null,
                    viewerEmail: viewerEmail ?? null,
                  };
                  await enqueueNotifications(
                    members
                      .map((m) => (m?.userId ? String(m.userId) : ""))
                      .filter((memberUserId) => Types.ObjectId.isValid(memberUserId))
                      .map((memberUserId) => ({
                        orgId: docOrgId,
                        userId: memberUserId,
                        kind: "share_views" as const,
                        dedupeKey: notificationDedupeKey("share_views", memberUserId, createdShareViewId),
                        event,
                        occurredAt: viewedAt,
                      })),
                  );
                  // Slack is a channel, not a member: one row per connected channel, posted now.
                  await enqueueSlackPosts({
                    orgId: docOrgId,
                    kind: "views",
                    sourceId: String(createdShareViewId),
                    event: { ...event, shareViewId: createdShareViewId },
                    occurredAt: viewedAt,
                  });
                }
              } catch {
                // best-effort
              }
            })();
          }

          // Denormalize viewer name/email for fast owner metrics reads (avoid $lookup).
          // Best-effort: only populate when we have an authenticated viewer and snapshot fields are missing.
          if (viewerUserId) {
            try {
              const u = await UserModel.findById(viewerUserId).select({ _id: 1, name: 1, email: 1 }).lean();
              const viewerName =
                u && typeof (u as any).name === "string" && (u as any).name.trim() ? (u as any).name.trim() : null;
              const viewerEmailSnapshot =
                u && typeof (u as any).email === "string" && (u as any).email.trim()
                  ? String((u as any).email).trim().toLowerCase()
                  : viewerEmail ?? null;
              if (viewerName || viewerEmailSnapshot) {
                await ShareViewModel.updateOne(
                  {
                    shareId,
                    botIdHash,
                    $or: [
                      { viewerName: { $exists: false } },
                      { viewerName: null },
                      { viewerEmailSnapshot: { $exists: false } },
                      { viewerEmailSnapshot: null },
                    ],
                  },
                  { $set: { ...(viewerName ? { viewerName } : {}), ...(viewerEmailSnapshot ? { viewerEmailSnapshot } : {}) } },
                );
              }
            } catch {
              // ignore
            }
          }

          if (pageNumber) {
            // `$addToSet` only. The `$set: setFields` this used to carry was already applied by the
            // upsert above, on the same document, moments earlier — so it re-sent the same fields
            // and re-touched the same six indexes for nothing.
            const add = await ShareViewModel.updateOne(
              { shareId, botIdHash, pagesSeen: { $ne: pageNumber } },
              { $addToSet: { pagesSeen: pageNumber } },
            );
            const added = Boolean((add as any)?.modifiedCount);
            // The same two rules as `numberOfViews`, and it needs both.
            //
            // An owner-side open is recorded on the row and counted nowhere: this counter feeds the
            // dashboard's "Pages viewed" tile, which read 13 against 11 real pages because the
            // owner's own paging through the deck landed in it.
            //
            // A page read through a project link is the data room's, not the document's
            // (`@/lib/analytics/docScope`), so it does not move the document's counter either.
            // Without the `projectTarget` half, the dashboard's two sharing tiles — fed by these two
            // counters and nothing else — disagreed with each other about the same reading: one
            // data-room read moved "Pages viewed" and left "Share views" where it was.
            if (added && !ownerPreview && !projectTarget) {
              await DocModel.updateOne({ _id: docId }, { $inc: { numberOfPagesViewed: 1 } });
            }
          }

          // Per-visit tracking (best-effort). This enables per-session details in owner metrics.
          if (visitIdHash) {
            try {
              const now = Date.now();
              const leftAt = leftAtMs ? new Date(leftAtMs) : new Date(now);
              const enteredAt = enteredAtMs ? new Date(enteredAtMs) : null;
              // Same two rules as the `ShareView` row above, from the same module, so a visit's
              // numbers and a viewer's numbers cannot disagree about what an interval means.
              const timing = {
                durationMs,
                pageDurationMs,
                enteredAtMs: enteredAt ? enteredAt.getTime() : null,
                leftAtMs: leftAt.getTime(),
              };
              const derivedPageDurationMs = pageTimeIncrement(timing);

              const setFields: Record<string, unknown> = {};
              if (viewerIp) setFields.viewerIp = viewerIp;
              if (viewerUserId) setFields.viewerUserId = viewerUserId;
              if (viewerEmail) setFields.viewerEmail = viewerEmail;
              if (!viewerUserId && viewerNameIntro) setFields.viewerName = viewerNameIntro;
              if (!viewerUserId && viewerEmail) setFields.viewerEmailSnapshot = viewerEmail;

              // Keep the "best-known" viewer snapshots on the visit record too.
              let viewerName: string | null = null;
              let viewerEmailSnapshot: string | null = null;
              if (viewerUserId) {
                try {
                  const u = await UserModel.findById(viewerUserId).select({ _id: 1, name: 1, email: 1 }).lean();
                  viewerName =
                    u && typeof (u as any).name === "string" && (u as any).name.trim() ? (u as any).name.trim() : null;
                  viewerEmailSnapshot =
                    u && typeof (u as any).email === "string" && (u as any).email.trim()
                      ? String((u as any).email).trim().toLowerCase()
                      : viewerEmail ?? null;
                } catch {
                  // ignore
                }
              }

              const update: Record<string, unknown> = {
                $setOnInsert: {
                  shareId,
                  docId,
                  botIdHash,
                  visitIdHash,
                  startedAt: enteredAt ?? leftAt,
                },
                // `lastEventAt` lives only in `$max`: naming it in `$setOnInsert` too made Mongo
                // refuse the whole upsert ("would create a conflict at 'lastEventAt'"), which the
                // surrounding catch swallowed — no ShareVisit row was ever written. `$max` against
                // a missing field sets it, so inserts still get the right value.
                //
                // `pagesSeen` was the same bug one field over: `pagesSeen: []` here collided with
                // the `$addToSet: { pagesSeen }` below, and Mongo validates operator paths before
                // applying, so EVERY payload carrying a pageNumber — which is every real one — was
                // rejected outright. The schema default covers the no-page insert and `$addToSet`
                // creates the array when it is absent, so the field must not be named here.
                $max: { lastEventAt: leftAt, ...(numPages ? { pageCount: numPages } : {}) },
              };

              const set: Record<string, unknown> = {
                ...(Object.keys(setFields).length ? setFields : {}),
                // Same flag as the `ShareView` row, so the per-visit timeline the owner reads
                // beside the counts excludes exactly the sessions the counts do.
                isOwnerPreview: ownerPreview,
                ...(viewerName ? { viewerName } : {}),
                ...(viewerEmailSnapshot ? { viewerEmailSnapshot } : {}),
                // `$set`, not `$setOnInsert`, for the same self-healing reason as `ShareView`.
                shareLinkId,
                ...(shareOrgId ? { orgId: shareOrgId } : {}),
                ...(timingVersion ? { timingVersion } : {}),
              };
              if (Object.keys(set).length) update.$set = set;

              const inc: Record<string, number> = {};
              // The visit's own total comes from the visit clock alone: a page-turn POST reports a
              // segment already inside the heartbeat's chunk, so counting it here added it twice.
              const visitMs = visitTimeIncrement(timing);
              if (visitMs) inc.timeSpentMs = visitMs;
              const shouldIncTime =
                typeof derivedPageDurationMs === "number" && Number.isFinite(derivedPageDurationMs) && derivedPageDurationMs > 0;
              if (shouldIncTime && pageNumber) inc[`pageTimeMsByPage.${String(pageNumber)}`] = Math.floor(derivedPageDurationMs);

              // Revisits and the page sequence describe a page the reader has *left*. `isPageExit`
              // holds the rule: an interval means an exit, and the 30-second heartbeat sends none.
              const canRecordPageEvent = Boolean(pageNumber) && shouldIncTime && isPageExit(timing);

              if (canRecordPageEvent) {
                // A hidden or idle split ends a segment without the reader leaving the page.
                if (countsAsPageRevisit(flushReason)) inc[`pageVisitCountByPage.${String(pageNumber!)}`] = 1;
                update.$addToSet = { pagesSeen: pageNumber };
                update.$push = {
                  pageEvents: {
                    $each: [
                      {
                        pageNumber,
                        enteredAt,
                        leftAt,
                        durationMs: Math.floor(derivedPageDurationMs!),
                        ...(flushReason ? { reason: flushReason } : {}),
                        ...(toPage ? { toPage } : {}),
                      },
                    ],
                    $slice: -500,
                  },
                };
              } else if (pageNumber) {
                // Still keep pagesSeen updated even if we can't record a full interval.
                update.$addToSet = { pagesSeen: pageNumber };
              }

              if (Object.keys(inc).length) update.$inc = inc;

              await ShareVisitModel.updateOne({ shareId, botIdHash, visitIdHash }, update, { upsert: true });

              /**
               * The visit brief's clock (docs/prds/lnkdrp-visit-briefs.md, decision 4). One upsert
               * per event moves this sitting's `dueAt` to two minutes from now; the `visit-briefs`
               * cron looks at it then and writes the brief once nothing has moved it further.
               * Keyed by the person (`viewerBotIdHash`), not the `<digest>.<docId>` row key, and by
               * the tab (`visitIdHash`), which on a data room is shared across every document —
               * so one row covers the whole sitting. Best-effort, after the visit row it describes.
               */
              await scheduleVisitBrief({
                orgId: shareOrgId ?? "",
                docId: String(docId),
                projectId: projectTarget ? String(projectTarget.project._id) : null,
                shareLinkId,
                shareId,
                visitIdHash,
                botIdHash: viewerBotIdHash,
                isOwnerPreview: ownerPreview,
                viewerUserId,
                viewerName: viewerNameIntro ?? null,
                viewerEmail: viewerEmail ?? null,
                at: viewedAt,
              });
            } catch (e) {
              // Loud on purpose: an operator-path conflict here silently emptied this collection
              // for months, and the symptom (no visits anywhere) looks identical to "no traffic".
              console.warn("[api/share/:shareId/stats] visit upsert failed", e);
            }
          }
        } catch (e) {
          // Best-effort analytics, but never silent: this is the only signal a write path is broken.
          console.warn("[api/share/:shareId/stats] analytics write failed", e);
        }
      });

      // Do NOT return stats here (owner-only); POST is used by public viewers.
      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      return errorJson(err, { status: 500, publicMessage: "Could not record view", context: "[api/share/:shareId/stats] POST failed" });
    }
  });
}




