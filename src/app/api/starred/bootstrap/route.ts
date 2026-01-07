/**
 * API route for `/api/starred/bootstrap`.
 *
 * One-time helper to migrate a user's localStorage starred cache into MongoDB.
 * The server remains the source of truth after bootstrapping.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { debugError, debugLog } from "@/lib/debug";
import { resolveActor } from "@/lib/gating/actor";
import { DocModel } from "@/lib/models/Doc";
import { StarredDocModel } from "@/lib/models/StarredDoc";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isObjectIdString(v: unknown): v is string {
  return typeof v === "string" && Types.ObjectId.isValid(v);
}

function docsVisibilityFilter(actor: { orgId: string; personalOrgId?: string | null; userId: string }) {
  const orgId = new Types.ObjectId(actor.orgId);
  const legacyUserId = new Types.ObjectId(actor.userId);
  const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
  return {
    isDeleted: { $ne: true },
    isArchived: { $ne: true },
    ...(allowLegacyByUserId
      ? {
          $or: [
            { orgId },
            { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          ],
        }
      : { orgId }),
  };
}

export async function POST(request: Request) {
  try {
    debugLog(2, "[api/starred/bootstrap] POST");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Partial<{
      docs: Array<{ docId: string; title?: string; starredAt?: number; sortKey?: number }>;
    }>;
    const input = Array.isArray(body.docs) ? body.docs : [];
    if (input.length > 200) return NextResponse.json({ error: "Too many items" }, { status: 400 });

    const cleaned: Array<{ docId: string; title: string; starredAt: number; sortKey: number }> = [];
    const seen = new Set<string>();
    for (const it of input) {
      const docId = typeof it?.docId === "string" ? it.docId.trim() : "";
      if (!isObjectIdString(docId) || seen.has(docId)) continue;
      seen.add(docId);
      const title = typeof it?.title === "string" ? it.title.trim() : "";
      const starredAt = Number.isFinite(it?.starredAt) ? Number(it.starredAt) : 0;
      const sortKey = Number.isFinite(it?.sortKey) ? Number(it.sortKey) : cleaned.length;
      cleaned.push({ docId, title, starredAt, sortKey });
    }

    if (!cleaned.length) return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const userId = new Types.ObjectId(actor.userId);

    // Only allow docs visible to the actor under current org context.
    const allowedDocs = await DocModel.find({
      ...docsVisibilityFilter(actor),
      _id: { $in: cleaned.map((d) => new Types.ObjectId(d.docId)) },
    })
      .select({ _id: 1 })
      .lean();
    const allowed = new Set(allowedDocs.map((d) => String(d._id)));

    const ops = cleaned
      .filter((d) => allowed.has(d.docId))
      .map((d) => ({
        updateOne: {
          filter: { orgId, userId, docId: new Types.ObjectId(d.docId) },
          update: {
            $setOnInsert: {
              orgId,
              userId,
              docId: new Types.ObjectId(d.docId),
              title: d.title,
              sortKey: d.sortKey,
              starredAt: d.starredAt ? new Date(d.starredAt) : new Date(),
            },
          },
          upsert: true,
        },
      }));
    if (ops.length) await StarredDocModel.bulkWrite(ops, { ordered: false });

    return NextResponse.json({ ok: true }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/starred/bootstrap] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


