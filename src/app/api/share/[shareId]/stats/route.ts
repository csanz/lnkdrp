import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
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
 * Handle GET requests.
 */


export async function GET(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      const { shareId } = await ctx.params;
      if (!shareId) {
        return applyTempUserHeaders(
          NextResponse.json({ error: "Missing shareId" }, { status: 400 }),
          actor,
        );
      }

      await connectMongo();
      const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
        .select({ userId: 1, numberOfViews: 1, numberOfPagesViewed: 1 })
        .lean();
      if (!doc) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }

      const isOwner = String(doc.userId) === actor.userId;
      const res = NextResponse.json(
        isOwner
          ? {
              isOwner: true,
              stats: {
                views: typeof doc.numberOfViews === "number" ? doc.numberOfViews : 0,
                pagesViewed: typeof doc.numberOfPagesViewed === "number" ? doc.numberOfPagesViewed : 0,
              },
            }
          : { isOwner: false },
      );
      return applyTempUserHeaders(res, actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  });
}
/**
 * Handle POST requests.
 */


export async function POST(request: Request, ctx: { params: Promise<{ shareId: string }> }) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    try {
      const { shareId } = await ctx.params;
      if (!shareId) {
        return applyTempUserHeaders(
          NextResponse.json({ error: "Missing shareId" }, { status: 400 }),
          actor,
        );
      }

      const body = (await request.json().catch(() => ({}))) as unknown;
      const botId = asNonEmptyString((body as { botId?: unknown })?.botId);
      const pageNumber = asPositiveInt((body as { pageNumber?: unknown })?.pageNumber);
      const viewerEmailRaw = asNonEmptyString((body as { viewerEmail?: unknown })?.viewerEmail);
      const viewerEmail = viewerEmailRaw ? normalizeEmail(viewerEmailRaw) : null;
      if (!botId) {
        return applyTempUserHeaders(
          NextResponse.json({ error: "Missing botId" }, { status: 400 }),
          actor,
        );
      }

      await connectMongo();
      const doc = await DocModel.findOne({ shareId, isDeleted: { $ne: true } })
        .select({ _id: 1 })
        .lean();
      if (!doc) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }

      const botIdHash = crypto.createHash("sha256").update(botId).digest("hex");
      const viewerUserId =
        actor.kind === "user" && Types.ObjectId.isValid(actor.userId)
          ? new Types.ObjectId(actor.userId)
          : null;
      const viewerIp = getClientIp(request);

      // Deduplicate by (shareId, botIdHash). On first-seen, increment views once.
      const existing = await ShareViewModel.findOne({ shareId, botIdHash })
        .select({ _id: 1, pagesSeen: 1 })
        .lean();

      if (!existing) {
        await ShareViewModel.create({
          shareId,
          docId: doc._id,
          botIdHash,
          pagesSeen: pageNumber ? [pageNumber] : [],
          ...(viewerIp ? { viewerIp } : {}),
          ...(viewerUserId ? { viewerUserId } : {}),
          ...(viewerEmail ? { viewerEmail } : {}),
        });
        await DocModel.updateOne(
          { _id: doc._id },
          {
            $inc: {
              numberOfViews: 1,
              ...(pageNumber ? { numberOfPagesViewed: 1 } : {}),
            },
          },
        );
      } else {
        const seen = Array.isArray(existing.pagesSeen) ? existing.pagesSeen : [];
        const update: Record<string, unknown> = {};
        if (viewerIp) update.viewerIp = viewerIp;
        if (viewerUserId) update.viewerUserId = viewerUserId;
        if (viewerEmail) update.viewerEmail = viewerEmail;

        // If we have new identity info, persist it even if pageNumber is a duplicate.
        if (Object.keys(update).length > 0) {
          await ShareViewModel.updateOne({ _id: existing._id }, { $set: update });
        }

        if (pageNumber && !seen.includes(pageNumber)) {
          await ShareViewModel.updateOne({ _id: existing._id }, { $addToSet: { pagesSeen: pageNumber } });
          await DocModel.updateOne({ _id: doc._id }, { $inc: { numberOfPagesViewed: 1 } });
        }
      }

      // Do NOT return stats here (owner-only); POST is used by public viewers.
      return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
  });
}




