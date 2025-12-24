import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

/**
 * Generate a short public identifier for `/s/:shareId`.
 *
 * Notes:
 * - This is NOT a secret; it’s a public slug.
 * - Collisions are extremely unlikely, but callers should still handle dupes.
 */
function newShareId() {
  // 12 chars-ish, URL-safe, no secrets (public identifier).
  return crypto.randomBytes(9).toString("base64url");
}

type CreateReturn = Awaited<ReturnType<typeof DocModel.create>>;
type CreatedDoc = CreateReturn extends (infer U)[] ? U : CreateReturn;

/**
 * List documents (paged).
 *
 * Query params:
 * - limit, page
 * - q: basic search over title/shareId
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const qRaw = url.searchParams.get("q") ?? "";
    const limit = Math.max(
      1,
      Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 25),
    );
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);
    const q = qRaw.trim();

    debugLog(2, "[api/docs] GET", { limit, page, q: q ? "[redacted]" : "" });
    const actor = await resolveActor(request);
    await connectMongo();

    // List most recently updated docs.
    const filter: Record<string, unknown> = {
      isDeleted: { $ne: true },
      isArchived: { $ne: true },
      userId: new Types.ObjectId(actor.userId),
    };
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ title: rx }, { shareId: rx }];
    }

    const total = await DocModel.countDocuments(filter);
    const docs = await DocModel.find(filter)
      .sort({ updatedDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean();

    // Include current upload version (best-effort) so UI can show v#.
    // Prefer `currentUploadId`, but fall back to legacy `uploadId` when present.
    const currentUploadIds = docs
      .map((d) => d.currentUploadId ?? (d as unknown as { uploadId?: unknown }).uploadId)
      .filter(Boolean);
    const uploadsById = new Map<string, number>();
    if (currentUploadIds.length) {
      const uploads = await UploadModel.find({ _id: { $in: currentUploadIds } })
        .select({ _id: 1, version: 1 })
        .lean();
      for (const u of uploads) {
        const v = (u as { version?: unknown }).version;
        if (Number.isFinite(v)) uploadsById.set(String(u._id), Number(v));
      }
    }

    // Best-effort: ensure shareIds exist for listed docs so links work.
    for (const d of docs) {
      if (d.shareId) continue;
      for (let i = 0; i < 3; i++) {
        const candidate = newShareId();
        try {
          await DocModel.updateOne(
            { _id: d._id, shareId: { $in: [null, undefined, ""] } },
            { $set: { shareId: candidate } },
          );
          d.shareId = candidate;
          break;
        } catch (e) {
          // Duplicate shareId; retry.
          if (
            e &&
            typeof e === "object" &&
            "code" in e &&
            (e as { code?: number }).code === 11000
          )
            continue;
          throw e;
        }
      }
    }

    return applyTempUserHeaders(
      NextResponse.json({
      total,
      page,
      limit,
      docs: docs.map((d) => {
        const currentUploadId =
          d.currentUploadId ?? (d as unknown as { uploadId?: unknown }).uploadId ?? null;
        return {
          id: String(d._id),
          shareId: d.shareId ?? null,
          title: d.title ?? "Untitled document",
          status: d.status ?? "draft",
          currentUploadId: currentUploadId ? String(currentUploadId) : null,
          version: currentUploadId ? uploadsById.get(String(currentUploadId)) ?? null : null,
          receiverRelevanceChecklist: Boolean(d.receiverRelevanceChecklist),
          updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
          createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
        };
      }),
      }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Create a new document with an initial shareId.
 */
export async function POST(request: Request) {
  try {
    debugLog(1, "[api/docs] POST");
    const actor = await resolveActor(request);
    await connectMongo();

    const body = (await request.json().catch(() => ({}))) as Partial<{
      title: string;
    }>;

    // Temp-user limit: 1 doc total.
    if (actor.kind === "temp") {
      const docCount = await DocModel.countDocuments({
        userId: new Types.ObjectId(actor.userId),
        isDeleted: { $ne: true },
      });
      if (docCount >= 1) {
        return applyTempUserHeaders(
          NextResponse.json(
            {
              error: "TEMP_USER_LIMIT",
              gate: { capability: "doc.create", limit: 1, used: docCount },
            },
            { status: 403 },
          ),
          actor,
        );
      }
    }

    // Create with a shareId (retry on rare collisions).
    let doc: CreatedDoc | null = null;
    for (let i = 0; i < 3; i++) {
      try {
        const created = await DocModel.create({
          userId: new Types.ObjectId(actor.userId),
          title: body.title ?? "Untitled document",
          status: "draft",
          shareId: newShareId(),
        });
        doc = (Array.isArray(created) ? created[0] : created) as CreatedDoc;
        break;
      } catch (e) {
        // Duplicate shareId; retry.
        if (
          e &&
          typeof e === "object" &&
          "code" in e &&
          (e as { code?: number }).code === 11000
        )
          continue;
        throw e;
      }
    }
    if (!doc) throw new Error("Failed to create doc");

    return applyTempUserHeaders(
      NextResponse.json(
        {
          doc: {
            id: String(doc._id),
            shareId: doc.shareId ?? null,
            title: doc.title ?? null,
            docName: doc.docName ?? null,
            fileName: doc.fileName ?? null,
            pageSlugs: doc.pageSlugs ?? [],
            status: doc.status ?? "draft",
            currentUploadId: doc.currentUploadId ? String(doc.currentUploadId) : null,
            blobUrl: doc.blobUrl ?? null,
            previewImageUrl: doc.previewImageUrl ?? doc.firstPagePngUrl ?? null,
            extractedText: doc.extractedText ?? doc.pdfText ?? null,
            aiOutput: doc.aiOutput ?? null,
            receiverRelevanceChecklist: Boolean(doc.receiverRelevanceChecklist),
          },
        },
        { status: 201 },
      ),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

