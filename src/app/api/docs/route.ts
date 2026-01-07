/**
 * API route for `/api/docs`.
 *
 * Lists and creates docs (ensures each doc has a public `/s/:shareId`).
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/**
 * Random Base62 (uses randomBytes, max, ceil).
 */


function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const remaining = length - out.length;
    const buf = crypto.randomBytes(Math.max(8, Math.ceil(remaining * 1.25)));
    for (const b of buf) {
      // 62 * 4 = 248, so values 0..247 map evenly to base62.
      if (b < 248) out += BASE62_ALPHABET[b % 62];
      if (out.length >= length) break;
    }
  }
  return out;
}

/**
 * Generate a short public identifier for `/s/:shareId`.
 *
 * Notes:
 * - This is NOT a secret; it’s a public slug.
 * - Collisions are extremely unlikely, but callers should still handle dupes.
 */
function newShareId() {
  // Alphanumeric only (no dashes/special chars) for friendlier share URLs.
  return randomBase62(12);
}

type CreateReturn = Awaited<ReturnType<typeof DocModel.create>>;
type CreatedDoc = CreateReturn extends (infer U)[] ? U : CreateReturn;

/**
 * List documents (paged).
 *
 * Query params:
 * - limit, page
 * - q: basic search over title/shareId
 * - ids: comma-separated list of doc ObjectIds to fetch directly (bypasses paging/search)
 */
export async function GET(request: Request) {
  try {
    const url = new URL(request.url);
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const qRaw = url.searchParams.get("q") ?? "";
    const idsRaw = url.searchParams.get("ids") ?? "";
    const limit = Math.max(
      1,
      Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 25),
    );
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);
    const q = qRaw.trim();
    const idsList = idsRaw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 50);
    const ids = idsList.length ? idsList.filter((id) => Types.ObjectId.isValid(id)) : [];

    debugLog(2, "[api/docs] GET", {
      limit,
      page,
      q: q ? "[redacted]" : "",
      ids: ids.length ? `[${ids.length}]` : "",
    });
    const actor = await resolveActor(request);
    await connectMongo();

    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    // List most recently updated docs.
    const filter: Record<string, unknown> = {
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
    if (ids.length) {
      // Direct lookup by IDs (used by the client for fast "starred docs" verification/metadata).
      filter._id = { $in: ids.map((id) => new Types.ObjectId(id)) };
    } else if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [{ title: rx }, { shareId: rx }];
    }

    const useIds = Boolean(ids.length);
    const total = useIds ? 0 : await DocModel.countDocuments(filter);
    // Stable ordering: when `updatedDate` ties (or is null), add a deterministic tiebreaker.
    // Without this, MongoDB is free to return ties in arbitrary order, causing UI "flip" on refresh.
    const docsUnordered = await DocModel.find(filter)
      .sort({ updatedDate: -1, _id: -1 })
      .skip(useIds ? 0 : (page - 1) * limit)
      .limit(useIds ? ids.length : limit)
      .lean();
    const docs = useIds
      ? (() => {
          // Preserve the caller's order for `ids=` requests (useful for starred ordering).
          const byId = new Map<string, (typeof docsUnordered)[number]>();
          for (const d of docsUnordered) byId.set(String(d._id), d);
          const ordered = ids.map((id) => byId.get(id)).filter(Boolean) as (typeof docsUnordered)[number][];
          // Include any stragglers (shouldn't happen often, but keeps response complete).
          const orderedIds = new Set(ids);
          for (const d of docsUnordered) {
            const id = String(d._id);
            if (!orderedIds.has(id)) ordered.push(d);
          }
          return ordered;
        })()
      : docsUnordered;
    const totalEffective = useIds ? docs.length : total;

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
      // Best-effort: backfill orgId for legacy personal docs so org scoping works.
      const dOrgId = (d as unknown as { orgId?: unknown }).orgId;
      if (allowLegacyByUserId && !dOrgId) {
        try {
          await DocModel.updateOne(
            { _id: d._id, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
            { $set: { orgId } },
            // Avoid bumping `updatedDate` for backfills; otherwise list order can "flip" on refresh.
            { timestamps: false },
          );
          (d as unknown as { orgId?: Types.ObjectId }).orgId = orgId;
        } catch {
          // ignore
        }
      }

      if (d.shareId) continue;
      for (let i = 0; i < 3; i++) {
        const candidate = newShareId();
        try {
          await DocModel.updateOne(
            { _id: d._id, shareId: { $in: [null, undefined, ""] } },
            { $set: { shareId: candidate } },
            // Avoid bumping `updatedDate` for backfills; otherwise list order can "flip" on refresh.
            { timestamps: false },
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

    // Best-effort: relate "guide docs" back to request repos even if older docs
    // haven't been backfilled with `guideForRequestProjectId` yet.
    const guideProjectIdByDocId = new Map<string, string>();
    try {
      const docIds = docs.map((d) => d._id).filter(Boolean);
      if (docIds.length) {
        const reqProjects = await ProjectModel.find({
          ...(allowLegacyByUserId
            ? {
                $or: [
                  { orgId },
                  { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
                ],
              }
            : { orgId }),
          isDeleted: { $ne: true },
          requestReviewGuideDocId: { $in: docIds },
          $or: [{ isRequest: true }, { requestUploadToken: { $exists: true, $nin: [null, ""] } }],
        })
          .select({ _id: 1, requestReviewGuideDocId: 1 })
          .lean();
        for (const p of reqProjects) {
          const guideIdRaw = (p as unknown as { requestReviewGuideDocId?: unknown }).requestReviewGuideDocId;
          if (!guideIdRaw) continue;
          guideProjectIdByDocId.set(String(guideIdRaw), String(p._id));
        }
      }
    } catch {
      // ignore; list endpoint is best-effort
    }

    return applyTempUserHeaders(
      NextResponse.json(
        {
          total: totalEffective,
          page: useIds ? 1 : page,
          limit: useIds ? ids.length : limit,
          docs: docs.map((d) => {
            const currentUploadId = d.currentUploadId ?? (d as unknown as { uploadId?: unknown }).uploadId ?? null;
            const ai = (d as unknown as { aiOutput?: unknown }).aiOutput;
            const oneLinerRaw =
              ai && typeof ai === "object" && "one_liner" in ai ? (ai as { one_liner?: unknown }).one_liner : null;
            const one_liner = typeof oneLinerRaw === "string" ? oneLinerRaw.trim() : "";
            const receivedViaRequestProjectIdRaw = (d as unknown as { receivedViaRequestProjectId?: unknown }).receivedViaRequestProjectId;
            const guideForRequestProjectIdRaw = (d as unknown as { guideForRequestProjectId?: unknown }).guideForRequestProjectId;
            const docId = String(d._id);
            return {
              id: String(d._id),
              shareId: d.shareId ?? null,
              title: d.title ?? "Untitled document",
              status: d.status ?? "draft",
              currentUploadId: currentUploadId ? String(currentUploadId) : null,
              version: currentUploadId ? uploadsById.get(String(currentUploadId)) ?? null : null,
              previewImageUrl: d.previewImageUrl ?? (d as unknown as { firstPagePngUrl?: unknown }).firstPagePngUrl ?? null,
              one_liner: one_liner || null,
              receiverRelevanceChecklist: Boolean(d.receiverRelevanceChecklist),
              receivedViaRequestProjectId: receivedViaRequestProjectIdRaw ? String(receivedViaRequestProjectIdRaw) : null,
              guideForRequestProjectId: (function () {
                if (guideForRequestProjectIdRaw) return String(guideForRequestProjectIdRaw);
                return guideProjectIdByDocId.get(docId) ?? null;
              })(),
              updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
              createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
            };
          }),
        },
        { headers: { "cache-control": "no-store" } },
      ),
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
          orgId: new Types.ObjectId(actor.orgId),
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

