/**
 * Admin API route: `GET /api/admin/data/requests/:requestId`
 *
 * Returns a request repo (Project) plus related docs/uploads/reviews for admin inspection.
 *
 * This handler redacted two of its four collections and served the other two whole, which is the
 * same as serving all four:
 *
 * - `request.raw` was the entire Project row. `requestViewToken` in it is read access to every PDF
 *   in the repo through `/api/request-view/:token/docs/:docId/pdf`, a route that resolves on the
 *   token alone — no session, so the read is not attributable to anyone. `requestUploadToken` is
 *   write access to the same repo. The page rendered the row as a "Raw record" JSON tab.
 * - Review rows carry the review agent's prompts, and those prompts are the deck's extracted text,
 *   fed in whole; the outputs are the AI's reading of it. Stripping `rawExtractedText` from the doc
 *   row in one tab while printing the same text as a prompt in the next is not a privacy control.
 *
 * Reviews are now selected for their shape only — status, model, timing, `inputTextChars` — with
 * the prompts and outputs left in the database.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { ReviewModel } from "@/lib/models/Review";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { redactDocRow, redactReviewRow, stripSecrets } from "@/lib/admin/docPrivacy";

export const runtime = "nodejs";



/**
 *
 */
function pickPlainObject(v: unknown) {
  // For admin inspection only: return the raw object if it's JSON-serializable-ish.
  if (!v || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

/**
 *
 */
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
          // Selected so `redactDocRow` can report whether each exists; it deletes all three before
          // the row leaves this route, the same trade the doc detail route makes.
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
          // `inputTextChars` is the stored size of the prompt, which is the whole diagnostic:
          // a review that came back empty or ran on nothing shows up here. The prompt itself
          // (`prompt`, `agentUserPrompt`) and the analysis written from it (`outputMarkdown`,
          // `intel`, `agentOutput`, `agentRawOutputText`) are the customer's deck and stay out.
          inputTextChars: 1,
          agentKind: 1,
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
      raw: stripSecrets(pickPlainObject(project) ?? {}),
    },
    docs: dedupedDocs.map((d) => ({
      id: String(d._id),
      userId: d.userId ? String(d.userId) : null,
      title: typeof d.title === "string" ? d.title : null,
      status: typeof d.status === "string" ? d.status : null,
      createdDate: d.createdDate ? new Date(d.createdDate).toISOString() : null,
      updatedDate: d.updatedDate ? new Date(d.updatedDate).toISOString() : null,
      isGuideDoc: guideDocId ? String(d._id) === String(guideDocId) : false,
      // `raw` is the whole row, so it needs the same redaction as the typed fields above.
      raw: redactDocRow(pickPlainObject(d) ?? {}),
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
      raw: redactDocRow(pickPlainObject(u) ?? {}),
    })),
    reviews: reviews.map((r) => ({
      id: String(r._id),
      docId: r.docId ? String(r.docId) : null,
      uploadId: r.uploadId ? String(r.uploadId) : null,
      version: Number.isFinite(r.version) ? r.version : null,
      status: typeof r.status === "string" ? r.status : null,
      model: typeof r.model === "string" ? r.model : null,
      agentKind: typeof (r as any).agentKind === "string" ? String((r as any).agentKind) : null,
      inputTextChars: Number.isFinite((r as { inputTextChars?: unknown }).inputTextChars)
        ? ((r as { inputTextChars: number }).inputTextChars)
        : null,
      createdDate: r.createdDate ? new Date(r.createdDate).toISOString() : null,
      updatedDate: (r as unknown as { updatedDate?: Date | string | null }).updatedDate
        ? new Date((r as unknown as { updatedDate: Date | string }).updatedDate).toISOString()
        : null,
      // The select above already leaves the prompts and the analysis behind; this is the second
      // lock, so widening that select later cannot quietly put them back on the wire.
      raw: redactReviewRow(pickPlainObject(r) ?? {}),
    })),
  });
}

/**
 *
 */
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


