/**
 * Admin API route: `GET /api/admin/data/requests/:requestId`
 *
 * Returns a request repo (Project) plus related docs/uploads for admin inspection.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { UserModel } from "@/lib/models/User";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { ReviewModel } from "@/lib/models/Review";

export const runtime = "nodejs";

function isLocalhostRequest(request: Request) {
  if (process.env.NODE_ENV === "production") return false;
  const host = (request.headers.get("host") ?? "").toLowerCase();
  return host.startsWith("localhost:") || host.startsWith("127.0.0.1:");
}

async function requireAdmin(request: Request) {
  if (isLocalhostRequest(request)) {
    return { ok: true as const, userId: null as string | null };
  }
  const actor = await resolveActor(request);
  if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
    return { ok: false as const, status: 401, error: "Not authenticated" };
  }

  await connectMongo();
  const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) })
    .select({ role: 1 })
    .lean();
  const role = (u as { role?: unknown } | null)?.role;
  if (role !== "admin") return { ok: false as const, status: 403, error: "Forbidden" };

  return { ok: true as const, userId: actor.userId };
}

function pickPlainObject(v: unknown) {
  // For admin inspection only: return the raw object if it's JSON-serializable-ish.
  if (!v || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

export async function GET(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { requestId } = await params;
  if (!Types.ObjectId.isValid(requestId)) {
    return NextResponse.json({ error: "Invalid requestId" }, { status: 400 });
  }

  await connectMongo();

  const project = await ProjectModel.findById(new Types.ObjectId(requestId)).lean();
  if (!project) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  // Best-effort guard: ensure it's actually a request repo.
  const pAny = project as Record<string, unknown>;
  const isRequest = Boolean(pAny.isRequest) || pAny.requestUploadToken != null;
  if (!isRequest) {
    return NextResponse.json({ error: "Not a request repo" }, { status: 400 });
  }

  const requestObjId = new Types.ObjectId(requestId);
  const guideDocIdRaw = pAny.requestReviewGuideDocId ?? null;
  const guideDocId =
    typeof guideDocIdRaw === "string" && Types.ObjectId.isValid(guideDocIdRaw) ? new Types.ObjectId(guideDocIdRaw) : null;

  // Related docs:
  // - canonical: docs explicitly marked as received via this request repo
  // - common: docs assigned to the request repo as a project (primary or multi-project membership)
  // - optional: guide doc attached to the request repo (if present)
  const or: Record<string, unknown>[] = [
    { receivedViaRequestProjectId: requestObjId },
    { projectId: requestObjId },
    { projectIds: requestObjId },
  ];
  if (guideDocId) or.push({ _id: guideDocId });

  const docFilter: Record<string, unknown> = {
    isDeleted: { $ne: true },
    $or: or,
  };

  const docs = await DocModel.find(docFilter)
    .sort({ createdDate: -1 })
    .limit(500)
    .select({
      userId: 1,
      title: 1,
      status: 1,
      shareId: 1,
      projectId: 1,
      projectIds: 1,
      receivedViaRequestProjectId: 1,
      aiOutput: 1,
      createdDate: 1,
      updatedDate: 1,
      currentUploadId: 1,
      uploadId: 1,
    })
    .lean();

  // De-dupe (guide doc may already be included via project membership).
  const seenDocIds = new Set<string>();
  const dedupedDocs = docs.filter((d) => {
    const id = String(d._id);
    if (seenDocIds.has(id)) return false;
    seenDocIds.add(id);
    return true;
  });

  const docIds = dedupedDocs.map((d) => d._id);
  const uploads = docIds.length
    ? await UploadModel.find({ isDeleted: { $ne: true }, docId: { $in: docIds } })
        .sort({ createdDate: -1 })
        .limit(1000)
        .select({
          userId: 1,
          docId: 1,
          version: 1,
          status: 1,
          originalFileName: 1,
          contentType: 1,
          sizeBytes: 1,
          blobUrl: 1,
          blobPathname: 1,
          uploadSecret: 1,
          skipReview: 1,
          aiOutput: 1,
          metadata: 1,
          error: 1,
          createdDate: 1,
          updatedDate: 1,
        })
        .lean()
    : [];

  const reviews = docIds.length
    ? await ReviewModel.find({ docId: { $in: docIds } })
        .sort({ createdDate: -1 })
        .limit(2000)
        .select({
          docId: 1,
          uploadId: 1,
          version: 1,
          status: 1,
          model: 1,
          prompt: 1,
          inputTextChars: 1,
          outputMarkdown: 1,
          intel: 1,
          agentKind: 1,
          agentOutput: 1,
          agentRawOutputText: 1,
          agentSystemPrompt: 1,
          agentUserPrompt: 1,
          priorReviewId: 1,
          priorReviewVersion: 1,
          error: 1,
          createdDate: 1,
          updatedDate: 1,
        })
        .lean()
    : [];

  return NextResponse.json({
    ok: true,
    request: {
      id: String((project as { _id: unknown })._id),
      raw: pickPlainObject(project),
    },
    docs: dedupedDocs.map((d) => ({
      id: String(d._id),
      userId: d.userId ? String(d.userId) : null,
      title: typeof d.title === "string" ? d.title : null,
      status: typeof d.status === "string" ? d.status : null,
      shareId: typeof d.shareId === "string" ? d.shareId : null,
      createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
      updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
      isGuideDoc: guideDocId ? String(d._id) === String(guideDocId) : false,
      raw: pickPlainObject(d),
    })),
    uploads: uploads.map((u) => ({
      id: String(u._id),
      userId: u.userId ? String(u.userId) : null,
      docId: u.docId ? String(u.docId) : null,
      version: Number.isFinite(u.version) ? u.version : null,
      status: typeof u.status === "string" ? u.status : null,
      originalFileName: typeof u.originalFileName === "string" ? u.originalFileName : null,
      createdDate: u.createdDate ? new Date(u.createdDate).toISOString() : null,
      updatedDate: (u as unknown as { updatedDate?: Date | string | null }).updatedDate
        ? new Date((u as unknown as { updatedDate: Date | string }).updatedDate).toISOString()
        : null,
      raw: pickPlainObject(u),
    })),
    reviews: reviews.map((r) => ({
      id: String(r._id),
      docId: r.docId ? String(r.docId) : null,
      uploadId: r.uploadId ? String(r.uploadId) : null,
      version: Number.isFinite(r.version) ? r.version : null,
      status: typeof r.status === "string" ? r.status : null,
      model: typeof r.model === "string" ? r.model : null,
      outputMarkdown: typeof r.outputMarkdown === "string" ? r.outputMarkdown : null,
      intel: (r as { intel?: unknown }).intel ?? null,
      agentKind: typeof (r as any).agentKind === "string" ? String((r as any).agentKind) : null,
      agentOutput: (r as any).agentOutput ?? null,
      agentRawOutputText: typeof (r as any).agentRawOutputText === "string" ? (r as any).agentRawOutputText : null,
      agentSystemPrompt: typeof (r as any).agentSystemPrompt === "string" ? (r as any).agentSystemPrompt : null,
      agentUserPrompt: typeof (r as any).agentUserPrompt === "string" ? (r as any).agentUserPrompt : null,
      createdDate: r.createdDate ? new Date(r.createdDate).toISOString() : null,
      updatedDate: (r as unknown as { updatedDate?: Date | string | null }).updatedDate
        ? new Date((r as unknown as { updatedDate: Date | string }).updatedDate).toISOString()
        : null,
      raw: pickPlainObject(r),
    })),
  });
}

export async function DELETE(request: Request, { params }: { params: Promise<{ requestId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { requestId } = await params;
  if (!Types.ObjectId.isValid(requestId)) {
    return NextResponse.json({ error: "Invalid requestId" }, { status: 400 });
  }

  await connectMongo();
  const res = await ProjectModel.updateOne({ _id: new Types.ObjectId(requestId) }, { $set: { isDeleted: true } });
  if (!res.matchedCount) return NextResponse.json({ error: "Request not found" }, { status: 404 });

  return NextResponse.json({ ok: true, requestId });
}


