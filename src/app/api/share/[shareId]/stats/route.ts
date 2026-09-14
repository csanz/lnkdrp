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
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { after } from "next/server";
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
      if (!resolved || resolved.refusal) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const doc = resolved.doc as { userId?: unknown };

      const isOwner = Boolean(session?.userId) && String(doc.userId) === String(session?.userId);
      if (!isOwner) {
        return NextResponse.json({ isOwner: false }, { headers: { "cache-control": "no-store" } });
      }

      // This endpoint's whole address is one link, so it answers for that link. It used to return
      // `Doc.numberOfViews` / `Doc.numberOfPagesViewed` — document-wide sums across every link —
      // and the owner overlay then cached them under a per-shareId key, so a quiet second link
      // reported the busy link's traffic. Same definitions as the owner metrics route.
      const [views, pagesAgg] = await Promise.all([
        ShareViewModel.countDocuments({ shareId }),
        ShareViewModel.aggregate([
          { $match: { shareId } },
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
      const visitId = asNonEmptyString((body as { visitId?: unknown })?.visitId, 256);
      const enteredAtMs = asEpochMs((body as { enteredAtMs?: unknown })?.enteredAtMs);
      const leftAtMs = asEpochMs((body as { leftAtMs?: unknown })?.leftAtMs);
      const viewerEmailRaw = asNonEmptyString((body as { viewerEmail?: unknown })?.viewerEmail);
      const viewerEmail = viewerEmailRaw ? normalizeEmail(viewerEmailRaw) : null;
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
      if (!resolved || resolved.refusal) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }
      const doc = resolved.doc;
      const shareLinkId = resolved.link._id;
      // Denormalized tenancy on the analytics rows (see `ShareView.orgId`).
      const shareOrgId = doc.orgId ? new Types.ObjectId(String(doc.orgId)) : null;

      // Perf: return immediately; analytics updates are best-effort.
      const docId = doc._id;
      const viewerIp = getClientIp(request);
      const session = await tryResolveAuthUserId(request);
      const viewerUserId =
        session?.userId && Types.ObjectId.isValid(session.userId) ? new Types.ObjectId(session.userId) : null;
      const botIdHash = crypto.createHash("sha256").update(botId).digest("hex");
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
          setFields.lastViewedAt = new Date();

          // The upsert is the write most likely to throw: two first-time POSTs for the same
          // (shareId, botIdHash) race and the unique index makes the loser fail with E11000. That
          // used to abort the whole analytics block — losing this heartbeat's pages and time too —
          // because the outer catch swallowed it. A duplicate key just means "the row exists".
          let created = false;
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
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (!/E11000|duplicate key/i.test(msg)) throw e;
          }

          // The link's `lastViewedAt` moves for every view, not only a first-time viewer's: a
          // recipient who comes back daily used to leave the links table reading "Never".
          void touchShareLink(shareId, "view", { countView: created });
          if (created) {
            await DocModel.updateOne({ _id: docId }, { $inc: { numberOfViews: 1 } });
            // Activity feed: one "viewed" event per new viewer of this share (not per page/visit).
            void (async () => {
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
                  title: typeof (doc as any)?.title === "string" ? String((doc as any).title) : null,
                  meta: {
                    authenticated: Boolean(viewerUserId),
                    viewerName: viewerNameIntro ?? null,
                    viewerEmail: viewerEmail ?? null,
                    shareId,
                    // Which link they came through: the feed renders "via Sequoia" and skips the
                    // suffix for the default link (see `linkSuffix` in src/lib/activity/labels.ts).
                    linkLabel: resolved.link.label ?? null,
                    isDefaultLink: Boolean(resolved.link.isDefault),
                  },
                  request,
                });
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
            if (added) {
              await DocModel.updateOne({ _id: docId }, { $inc: { numberOfPagesViewed: 1 } });
            }
          }

          if (durationMs) {
            // Increment total time spent, and best-effort per-page time if we know the page number.
            const inc: Record<string, number> = { timeSpentMs: durationMs };
            if (pageNumber) inc[`pageTimeMsByPage.${String(pageNumber)}`] = durationMs;
            await ShareViewModel.updateOne({ shareId, botIdHash }, { $inc: inc });
          }

          // Per-visit tracking (best-effort). This enables per-session details in owner metrics.
          if (visitIdHash) {
            try {
              const now = Date.now();
              const leftAt = leftAtMs ? new Date(leftAtMs) : new Date(now);
              const enteredAt = enteredAtMs ? new Date(enteredAtMs) : null;
              const derivedDurationMs =
                durationMs ??
                (enteredAt ? Math.max(0, Math.min(24 * 60 * 60 * 1000, leftAt.getTime() - enteredAt.getTime())) : null);

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
                $max: { lastEventAt: leftAt },
              };

              const set: Record<string, unknown> = {
                ...(Object.keys(setFields).length ? setFields : {}),
                ...(viewerName ? { viewerName } : {}),
                ...(viewerEmailSnapshot ? { viewerEmailSnapshot } : {}),
                // `$set`, not `$setOnInsert`, for the same self-healing reason as `ShareView`.
                shareLinkId,
                ...(shareOrgId ? { orgId: shareOrgId } : {}),
              };
              if (Object.keys(set).length) update.$set = set;

              const inc: Record<string, number> = {};
              const shouldIncTime = typeof derivedDurationMs === "number" && Number.isFinite(derivedDurationMs) && derivedDurationMs > 0;
              if (shouldIncTime) inc.timeSpentMs = Math.floor(derivedDurationMs);
              if (shouldIncTime && pageNumber) inc[`pageTimeMsByPage.${String(pageNumber)}`] = Math.floor(derivedDurationMs);

              // Revisits/page-sequence require a well-defined page interval (enteredAt/leftAt).
              const canRecordPageEvent =
                Boolean(pageNumber) &&
                Boolean(enteredAt) &&
                shouldIncTime &&
                enteredAt!.getTime() <= leftAt.getTime();

              if (canRecordPageEvent) {
                inc[`pageVisitCountByPage.${String(pageNumber!)}`] = 1;
                update.$addToSet = { pagesSeen: pageNumber };
                update.$push = {
                  pageEvents: {
                    $each: [{ pageNumber, enteredAt, leftAt, durationMs: Math.floor(derivedDurationMs!) }],
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




