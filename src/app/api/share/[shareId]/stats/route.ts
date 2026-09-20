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
import { resolveShareLink, touchShareLink } from "@/lib/share/links";
import { projectLinkPasswordEnabled, projectViewerKey, resolveProjectStatsTarget } from "@/lib/share/projectPublic";
import { propagateViewerIdentity, viewerIdentityNews } from "@/lib/share/viewerIdentity";
import { enqueueNotification, notificationDedupeKey } from "@/lib/notifications/queue";
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
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { after } from "next/server";
import { cookies } from "next/headers";
import { UserModel } from "@/lib/models/User";
import { clientIpFromRequest, rateLimit, rateLimitedResponse } from "@/lib/http/rateLimit";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";

/** Public ingest budget per IP per minute (viewer heartbeats are a few per page). */
const STATS_POST_LIMIT = 120;
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
 * As Positive Int (uses Number, isFinite, floor).
 */


function asPositiveInt(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  const i = Math.floor(n);
  return i >= 1 ? i : null;
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
      const projectTarget = resolved
        ? null
        : await resolveProjectStatsTarget({ shareId, request, select: { userId: 1, orgId: 1 } as Record<string, 1> });
      if ((!resolved || resolved.refusal) && (!projectTarget || projectTarget.refusal)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
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
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
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
      const pageNumber = asPositiveInt((body as { pageNumber?: unknown })?.pageNumber);
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

      // Public endpoint: bound write volume per IP. The limiter key uses only proxy-set headers
      // (`x-forwarded-for` first hop / `x-real-ip`): `getClientIp` also honours `cf-connecting-ip` /
      // `true-client-ip`, which a direct caller could set to rotate buckets. Keep that one for
      // analytics attribution only.
      const rl = await rateLimit({
        key: `sharestats:ip:${clientIpFromRequest(request)}`,
        limit: STATS_POST_LIMIT,
        windowMs: STATS_POST_WINDOW_MS,
      });
      if (!rl.ok) return rateLimitedResponse(rl);

      // Views are recorded against the link that was opened; a refused link records nothing.
      const resolved = await resolveShareLink(shareId, { select: { title: 1 } as Record<string, 1> });
      /**
       * The project-link path (PRD decision 5). `resolveShareLink` returns null for a project
       * slug by design, so only then do we ask which document of that project is being read — from
       * the body if a client sends it, otherwise from the `/p/:shareId/:docId` page that made the
       * request (`resolveProjectStatsTarget`, which re-proves the document is in the project).
       * Everything below this point is the same code the document path runs; that is the whole
       * bargain of decision 5 — reading time, sessions and page sequences with no new timing code.
       */
      const projectTarget = resolved
        ? null
        : await resolveProjectStatsTarget({ shareId, request, bodyDocId: (body as { docId?: unknown })?.docId, select: { title: 1, userId: 1, orgId: 1 } as Record<string, 1> });
      if ((!resolved || resolved.refusal) && (!projectTarget || projectTarget.refusal)) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const link = resolved ? resolved.link : projectTarget!.link;
      // A locked project link ingests nothing until the password has been given. The viewer at
      // `/p/:shareId/:docId` only renders behind that gate, so this costs a real recipient nothing
      // — but the route is public, and `resolveProjectStatsTarget` proves only that the document is
      // *in* the project, never that this caller was allowed to open it. Same guard, same reasoning
      // and same quiet 200 as `POST /api/share/:shareId/landing`.
      //
      // Project branch only, deliberately: the document ingest has always accepted a view on a
      // locked `/s/:shareId` and changing that here would alter document behaviour, which this
      // change must not do. Flagged in the report instead.
      if (projectTarget && projectLinkPasswordEnabled(link as { passwordHash?: string | null; passwordSalt?: string | null })) {
        const jar = await cookies();
        const presented = jar.get(shareAuthCookieName(shareId))?.value ?? "";
        const expected = shareAuthCookieValue({ shareId, sharePasswordHash: String((link as { passwordHash?: unknown }).passwordHash ?? "") });
        if (!presented || presented !== expected) {
          return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
        }
      }
      const doc = (resolved ? resolved.doc : projectTarget!.doc) as Record<string, unknown> & { _id: unknown; orgId?: unknown };
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
          try {
            const upsert = await ShareViewModel.updateOne(
              { shareId, botIdHash },
              {
                $setOnInsert: {
                  shareId,
                  docId,
                  botIdHash,
                  pagesSeen: [],
                },
                $set: setFields,
              },
              { upsert: true },
            );
            created = Boolean((upsert as any)?.upsertedCount);
            const upsertedId = (upsert as { upsertedId?: unknown } | null)?.upsertedId;
            createdShareViewId =
              created && upsertedId && Types.ObjectId.isValid(String(upsertedId))
                ? new Types.ObjectId(String(upsertedId))
                : null;
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/E11000|duplicate key/i.test(msg)) throw e;
          }

          if ((identityNews.isNew || identityNews.changed) && !ownerPreview && shareOrgId) {
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
            try {
              await propagateViewerIdentity({
                shareId,
                botIdHash,
                orgId: shareOrgId ?? null,
                name: viewerNameIntro,
                email: viewerEmail,
              });
            } catch {
              // best-effort: the row this heartbeat wrote already carries the new identity.
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
                if (createdShareViewId) {
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
                  await Promise.all(
                    members.map(async (m) => {
                      const memberUserId = m?.userId ? String(m.userId) : "";
                      if (!Types.ObjectId.isValid(memberUserId)) return;
                      await enqueueNotification({
                        orgId: docOrgId,
                        userId: memberUserId,
                        kind: "share_views",
                        dedupeKey: notificationDedupeKey("share_views", memberUserId, createdShareViewId),
                        event: {
                          docId: String(docId),
                          projectId: projectTarget ? String(projectTarget.project._id) : null,
                          shareId,
                          // The PERSON, so `viewerBotIdHash` and never `botIdHash` (decision 9): on
                          // a project link the latter is the `<digest>.<docId>` composite, and the
                          // document already has its own field on the row. Three bugs this month
                          // came from those two shapes being compared literally.
                          viewerKey: viewerBotIdHash,
                          viewerName: viewerNameIntro ?? null,
                          viewerEmail: viewerEmail ?? null,
                        },
                        occurredAt: viewedAt,
                      });
                    }),
                  );
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
            const add = await ShareViewModel.updateOne(
              { shareId, botIdHash, pagesSeen: { $ne: pageNumber } },
              {
                $addToSet: { pagesSeen: pageNumber },
                ...(Object.keys(setFields).length ? { $set: setFields } : {}),
              },
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

          // Each counter is fed by its own clock — see `src/lib/analytics/shareTiming.ts`, which
          // holds the rules and the reasons they are not four lines inline any more.
          {
            const timing = { durationMs, pageDurationMs, enteredAtMs, leftAtMs };
            const visitMs = visitTimeIncrement(timing);
            const pageMs = pageNumber ? pageTimeIncrement(timing) : null;
            const inc: Record<string, number> = {};
            if (visitMs) inc.timeSpentMs = visitMs;
            if (pageNumber && pageMs) inc[`pageTimeMsByPage.${String(pageNumber)}`] = pageMs;
            if (Object.keys(inc).length) await ShareViewModel.updateOne({ shareId, botIdHash }, { $inc: inc });
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
      return errorJson(err, { status: 400, publicMessage: "Could not record view", context: "[api/share/:shareId/stats] POST failed" });
    }
  });
}




