/**
 * API route for `/api/starred`.
 *
 * Starred docs are persisted in MongoDB (source of truth). The client may cache
 * them in localStorage for fast UX.
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

type StarredRow = { id: string; title: string; starredAt: number; sortKey: number };

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

async function listStarred(actor: { orgId: string; userId: string }): Promise<StarredRow[]> {
  const orgId = new Types.ObjectId(actor.orgId);
  const userId = new Types.ObjectId(actor.userId);
  const rows = await StarredDocModel.find({ orgId, userId })
    .sort({ sortKey: 1, createdDate: 1, _id: 1 })
    .select({ docId: 1, title: 1, starredAt: 1, sortKey: 1 })
    .lean();
  return rows.map((r) => ({
    id: String((r as unknown as { docId?: unknown }).docId),
    title: String((r as unknown as { title?: unknown }).title ?? ""),
    starredAt: (() => {
      const d = (r as unknown as { starredAt?: unknown }).starredAt;
      const t = d instanceof Date ? d.getTime() : Date.parse(String(d ?? ""));
      return Number.isFinite(t) ? t : 0;
    })(),
    sortKey: Number.isFinite((r as unknown as { sortKey?: unknown }).sortKey)
      ? Number((r as unknown as { sortKey?: unknown }).sortKey)
      : 0,
  }));
}

export async function GET(request: Request) {
  try {
    debugLog(2, "[api/starred] GET");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
    await connectMongo();

    const docs = await listStarred({ orgId: actor.orgId, userId: actor.userId });
    return NextResponse.json({ docs }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/starred] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function POST(request: Request) {
  try {
    debugLog(2, "[api/starred] POST");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Partial<{ docId: string; title?: string }>;
    const docId = typeof body.docId === "string" ? body.docId.trim() : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!isObjectIdString(docId)) return NextResponse.json({ error: "Invalid docId" }, { status: 400 });

    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const userId = new Types.ObjectId(actor.userId);
    const docObjectId = new Types.ObjectId(docId);

    // Ensure the doc is visible to this actor under current workspace context.
    const ok = await DocModel.exists({ ...docsVisibilityFilter(actor), _id: docObjectId });
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const existing = await StarredDocModel.findOne({ orgId, userId, docId: docObjectId })
      .select({ _id: 1 })
      .lean();

    if (existing?._id) {
      await StarredDocModel.deleteOne({ _id: existing._id });
    } else {
      const min = await StarredDocModel.findOne({ orgId, userId }).sort({ sortKey: 1 }).select({ sortKey: 1 }).lean();
      const minKey = Number.isFinite((min as unknown as { sortKey?: unknown })?.sortKey)
        ? Number((min as unknown as { sortKey?: unknown }).sortKey)
        : 0;
      const nextSortKey = min ? minKey - 1 : 0;
      await StarredDocModel.create({
        orgId,
        userId,
        docId: docObjectId,
        title,
        sortKey: nextSortKey,
        starredAt: new Date(),
      });
    }

    const docs = await listStarred({ orgId: actor.orgId, userId: actor.userId });
    return NextResponse.json({ docs }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/starred] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

export async function PATCH(request: Request) {
  try {
    debugLog(2, "[api/starred] PATCH");
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });

    const body = (await request.json().catch(() => ({}))) as Partial<{ docIds: string[] }>;
    const docIdsRaw = Array.isArray(body.docIds) ? body.docIds : [];
    const docIds = docIdsRaw.map((s) => String(s ?? "").trim()).filter(Boolean);
    if (docIds.length > 200) return NextResponse.json({ error: "Too many items" }, { status: 400 });

    const uniqueIds: string[] = [];
    const seen = new Set<string>();
    for (const id of docIds) {
      if (!isObjectIdString(id)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      uniqueIds.push(id);
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const userId = new Types.ObjectId(actor.userId);

    // Only reorder docs that are currently starred.
    const current = await StarredDocModel.find({ orgId, userId })
      .sort({ sortKey: 1, createdDate: 1, _id: 1 })
      .select({ docId: 1 })
      .lean();
    const currentIds = current.map((r) => String((r as unknown as { docId?: unknown }).docId));
    const currentSet = new Set(currentIds);

    const nextIds = uniqueIds.filter((id) => currentSet.has(id));
    for (const id of currentIds) {
      if (!seen.has(id)) nextIds.push(id);
    }

    const ops = nextIds.map((id, idx) => ({
      updateOne: {
        filter: { orgId, userId, docId: new Types.ObjectId(id) },
        update: { $set: { sortKey: idx } },
      },
    }));
    if (ops.length) await StarredDocModel.bulkWrite(ops, { ordered: false });

    const docs = await listStarred({ orgId: actor.orgId, userId: actor.userId });
    return NextResponse.json({ docs }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/starred] PATCH failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


