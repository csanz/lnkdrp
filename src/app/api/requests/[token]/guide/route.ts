/**
 * API route for `/api/requests/:requestId/guide`.
 *
 * Attach a "guide document" (thesis/RFP/job description) to a request folder so the
 * review agent can use its extracted text as additional context.
 *
 * Note: This route lives under `[token]` to keep the dynamic segment name consistent
 * across `/api/requests/:.../*` routes (Next.js requires this). The value here is
 * still a Project ObjectId (requestId), not the public upload token.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
/**
 * Handle POST requests.
 */


export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await ctx.params;
    const requestId = token;
    if (!requestId || !Types.ObjectId.isValid(requestId)) {
      return NextResponse.json({ error: "Invalid requestId" }, { status: 400 });
    }

    debugLog(1, "[api/requests/:requestId/guide] POST", { requestId });
    const actor = await resolveActor(request);
    if (actor.kind !== "user") {
      return applyTempUserHeaders(
        NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 }),
        actor,
      );
    }

    const body = (await request.json().catch(() => ({}))) as Partial<{ docId: string }>;
    const docId = typeof body.docId === "string" ? body.docId.trim() : "";
    if (!docId || !Types.ObjectId.isValid(docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;

    const project = await ProjectModel.findOne({
      _id: new Types.ObjectId(requestId),
      ...(allowLegacyByUserId
        ? {
            $or: [
              { orgId },
              { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
            ],
          }
        : { orgId }),
      isDeleted: { $ne: true },
      $or: [
        { isRequest: true },
        { requestUploadToken: { $exists: true, $nin: [null, ""] } },
      ],
    })
      .select({ _id: 1, isRequest: 1, requestUploadToken: 1, requestReviewGuideDocId: 1 })
      .lean();
    if (!project) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const prevGuideDocIdRaw = (project as unknown as { requestReviewGuideDocId?: unknown }).requestReviewGuideDocId ?? null;
    const prevGuideDocId =
      prevGuideDocIdRaw && Types.ObjectId.isValid(String(prevGuideDocIdRaw))
        ? new Types.ObjectId(String(prevGuideDocIdRaw))
        : null;

    // Best-effort backfill: if this repo has a token, persist `isRequest=true`.
    try {
      const persistedIsRequest = Boolean((project as unknown as { isRequest?: unknown }).isRequest);
      const tokenRaw = (project as unknown as { requestUploadToken?: unknown }).requestUploadToken;
      const hasToken = typeof tokenRaw === "string" && tokenRaw.trim();
      if (!persistedIsRequest && hasToken) {
        await ProjectModel.updateOne(
          {
            _id: new Types.ObjectId(requestId),
            ...(allowLegacyByUserId
              ? {
                  $or: [
                    { orgId },
                    { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
                  ],
                }
              : { orgId }),
          },
          { $set: { isRequest: true } },
        );
      }
    } catch {
      // ignore; request behavior should still work based on token existence
    }

    const doc = await DocModel.findOne({
      _id: new Types.ObjectId(docId),
      ...(allowLegacyByUserId
        ? {
            $or: [
              { orgId },
              { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
            ],
          }
        : { orgId }),
      isDeleted: { $ne: true },
    })
      .select({ _id: 1 })
      .lean();
    if (!doc) return NextResponse.json({ error: "Doc not found" }, { status: 404 });

    await ProjectModel.updateOne(
      {
        _id: new Types.ObjectId(requestId),
        ...(allowLegacyByUserId
          ? {
              $or: [
                { orgId },
                { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
              ],
            }
          : { orgId }),
      },
      { $set: { requestReviewGuideDocId: new Types.ObjectId(docId) } },
    );

    // Link the guide doc back to this request repo (durable doc-level pointer).
    await DocModel.updateOne(
      {
        _id: new Types.ObjectId(docId),
        ...(allowLegacyByUserId
          ? {
              $or: [
                { orgId },
                { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
              ],
            }
          : { orgId }),
      },
      { $set: { guideForRequestProjectId: new Types.ObjectId(requestId) } },
    );

    // Best-effort cleanup: if we replaced an existing guide doc for this request,
    // clear its backlink so old guide docs don't keep showing request context.
    if (prevGuideDocId && String(prevGuideDocId) !== String(docId)) {
      await DocModel.updateOne(
        {
          _id: prevGuideDocId,
          ...(allowLegacyByUserId
            ? {
                $or: [
                  { orgId },
                  { userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
                ],
              }
            : { orgId }),
          guideForRequestProjectId: new Types.ObjectId(requestId),
        },
        { $set: { guideForRequestProjectId: null } },
      );
    }

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/requests/:requestId/guide] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


