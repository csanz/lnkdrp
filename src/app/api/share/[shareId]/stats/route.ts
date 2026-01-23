import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { ShareVisitModel } from "@/lib/models/ShareVisit";
import { tryResolveAuthUserId } from "@/lib/gating/actor";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";
import { after } from "next/server";
import { UserModel } from "@/lib/models/User";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * As Non Empty String (uses trim).
 */


function asNonEmptyString(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  return s ? s : null;
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

      await connectMongo();
      const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
        .select({ userId: 1, numberOfViews: 1, numberOfPagesViewed: 1 })
        .lean();
      if (!doc) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      const isOwner = Boolean(session?.userId) && String(doc.userId) === String(session?.userId);
      return NextResponse.json(
        isOwner
          ? {
              isOwner: true,
              stats: {
                views: typeof doc.numberOfViews === "number" ? doc.numberOfViews : 0,
                pagesViewed: typeof doc.numberOfPagesViewed === "number" ? doc.numberOfPagesViewed : 0,
              },
            }
          : { isOwner: false },
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
      if (!botId) {
        return NextResponse.json({ error: "Missing botId" }, { status: 400 });
      }

      await connectMongo();
      const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
        .select({ _id: 1 })
        .lean();
      if (!doc) {
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

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

          const upsert = await ShareViewModel.updateOne(
            { shareId, botIdHash },
            {
              $setOnInsert: {
                shareId,
                docId,
                botIdHash,
                pagesSeen: [],
              },
              ...(Object.keys(setFields).length ? { $set: setFields } : {}),
            },
            { upsert: true },
          );

          const created = Boolean((upsert as any)?.upsertedCount);
          if (created) {
            await DocModel.updateOne({ _id: docId }, { $inc: { numberOfViews: 1 } });
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
                  lastEventAt: leftAt,
                  pagesSeen: [],
                },
                $max: { lastEventAt: leftAt },
              };

              const set: Record<string, unknown> = {
                ...(Object.keys(setFields).length ? setFields : {}),
                ...(viewerName ? { viewerName } : {}),
                ...(viewerEmailSnapshot ? { viewerEmailSnapshot } : {}),
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
            } catch {
              // ignore
            }
          }
        } catch {
          // ignore; best-effort analytics
        }
      });

      // Do NOT return stats here (owner-only); POST is used by public viewers.
      return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return NextResponse.json({ error: message }, { status: 400 });
    }
  });
}




