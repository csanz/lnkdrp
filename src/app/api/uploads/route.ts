import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";
import { connectMongo } from "@/lib/mongodb";
import { UploadModel } from "@/lib/models/Upload";
import { DocModel } from "@/lib/models/Doc";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";

/**
 * Generate a short public identifier for `/s/:shareId`.
 *
 * This is a public slug (not a secret).
 */
function newShareId() {
  // Public, URL-safe identifier (avoid exposing Mongo `_id` in share URLs).
  return crypto.randomBytes(9).toString("base64url");
}

/**
 * List uploads (paged).
 *
 * Query params:
 * - limit, page
 * - q: searches originalFileName and doc title
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

    debugLog(2, "[api/uploads] GET", { limit, page, q: q ? "[redacted]" : "" });
    const actor = await resolveActor(request);
    await connectMongo();

    const filter: Record<string, unknown> = {
      isDeleted: { $ne: true },
      userId: new Types.ObjectId(actor.userId),
    };

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      const matchingDocs = await DocModel.find({ title: rx })
        .select({ _id: 1 })
        .limit(500)
        .lean();
      const docIds = matchingDocs.map((d) => d._id);
      filter.$or = [{ originalFileName: rx }, ...(docIds.length ? [{ docId: { $in: docIds } }] : [])];
    }

    const total = await UploadModel.countDocuments(filter);
    const uploads = await UploadModel.find(filter)
      .sort({ createdDate: -1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .populate({ path: "docId", select: { title: 1, shareId: 1 } })
      .lean();

    return applyTempUserHeaders(
      NextResponse.json({
        total,
        page,
        limit,
        uploads: uploads.map((u) => {
          const doc = (u.docId ?? null) as
            | { _id?: unknown; title?: unknown; shareId?: unknown }
            | null;

          const docId =
            doc && doc._id ? String(doc._id) : u.docId ? String(u.docId) : null;

          return {
            id: String(u._id),
            docId,
            docTitle:
              doc && typeof doc.title === "string" && doc.title
                ? doc.title
                : typeof u.originalFileName === "string" && u.originalFileName
                  ? u.originalFileName
                  : "Untitled",
            shareId: doc && typeof doc.shareId === "string" ? doc.shareId : null,
            version: Number.isFinite(u.version) ? u.version : null,
            status: u.status ?? null,
            createdDate: u.createdDate ? new Date(u.createdDate).toISOString() : null,
          };
        }),
      }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/uploads] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

/**
 * Create a new upload record for a doc.
 *
 * This also moves the doc into `preparing` state immediately so the UI can
 * render a consistent "processing" experience while the file uploads.
 */
export async function POST(request: Request) {
  try {
    debugLog(1, "[api/uploads] POST");
    const actor = await resolveActor(request);
    const body = (await request.json().catch(() => ({}))) as Partial<{
      docId: string;
      originalFileName: string;
      contentType: string;
      sizeBytes: number;
    }>;

    if (!body.docId || !Types.ObjectId.isValid(body.docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    await connectMongo();

    // Ensure doc exists
    let doc = await DocModel.findOne({
      _id: new Types.ObjectId(body.docId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    });
    if (!doc) return NextResponse.json({ error: "Doc not found" }, { status: 404 });

    // Ensure the doc has a public shareId at upload time.
    if (!doc.shareId) {
      for (let i = 0; i < 3; i++) {
        try {
          doc.shareId = newShareId();
          await doc.save();
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
      // refresh instance so later responses (if any) see latest
      doc = await DocModel.findOne({
        _id: new Types.ObjectId(body.docId),
        userId: new Types.ObjectId(actor.userId),
        isDeleted: { $ne: true },
      });
    }

    // Monotonic per-doc version number (1 = initial upload, 2+ = re-uploads)
    const existingUploads = await UploadModel.countDocuments({
      docId: new Types.ObjectId(body.docId),
      userId: new Types.ObjectId(actor.userId),
      isDeleted: { $ne: true },
    });

    // Temp-user limit: 1 initial upload + 2 replacements => max 3 total versions.
    if (actor.kind === "temp" && existingUploads >= 3) {
      return applyTempUserHeaders(
        NextResponse.json(
          {
            error: "TEMP_USER_LIMIT",
            gate: { capability: "upload.replace", limit: 3, used: existingUploads },
          },
          { status: 403 },
        ),
        actor,
      );
    }

    const version = existingUploads + 1;

    const upload = await UploadModel.create({
      userId: new Types.ObjectId(actor.userId),
      docId: new Types.ObjectId(body.docId),
      version,
      status: "uploading",
      originalFileName: body.originalFileName ?? null,
      contentType: body.contentType ?? null,
      sizeBytes: Number.isFinite(body.sizeBytes) ? body.sizeBytes : null,
      metadata: {
        size: Number.isFinite(body.sizeBytes) ? body.sizeBytes : undefined,
      },
    });

    // Move doc into preparing immediately (post-share flow)
    await DocModel.findByIdAndUpdate(body.docId, {
      status: "preparing",
      currentUploadId: upload._id,
      uploadId: upload._id, // backward compat
    });

    return applyTempUserHeaders(
      NextResponse.json(
        {
          upload: {
            id: String(upload._id),
            docId: String(upload.docId),
            version: Number.isFinite(upload.version) ? upload.version : null,
            status: upload.status ?? "uploading",
            blobUrl: upload.blobUrl ?? null,
            blobPathname: upload.blobPathname ?? null,
            previewImageUrl:
              upload.previewImageUrl ?? upload.firstPagePngUrl ?? null,
            rawExtractedText:
              upload.rawExtractedText ?? upload.pdfText ?? null,
          },
        },
        { status: 201 },
      ),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/uploads] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

