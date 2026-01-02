import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ReviewModel } from "@/lib/models/Review";
import { debugError, debugLog } from "@/lib/debug";
import { DocModel } from "@/lib/models/Doc";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
/**
 * Return whether object id.
 */


function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}

/**
 * List reviews for a doc (paged).
 *
 * Query params:
 * - limit, page
 * - latest=1 (optional): only return the latest review
 */
export async function GET(
  request: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  try {
    const { docId } = await ctx.params;
    if (!isObjectId(docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    const url = new URL(request.url);
    const latestOnly = url.searchParams.get("latest") === "1";
    const limitRaw = url.searchParams.get("limit");
    const pageRaw = url.searchParams.get("page");
    const limit = Math.max(
      1,
      Math.min(50, Number.isFinite(Number(limitRaw)) ? Number(limitRaw) : 25),
    );
    const page = Math.max(1, Number.isFinite(Number(pageRaw)) ? Number(pageRaw) : 1);

    debugLog(2, "[api/docs/:docId/reviews] GET", { docId, latestOnly, limit, page });
    const actor = await resolveActor(request);
    await connectMongo();

    // Authorization: doc must belong to the actor.
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docExists = await DocModel.exists({
      ...(allowLegacyByUserId
        ? {
            $or: [
              { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } },
              {
                _id: new Types.ObjectId(docId),
                userId: legacyUserId,
                isDeleted: { $ne: true },
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ],
          }
        : { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } }),
    });
    if (!docExists) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const filter = { docId: new Types.ObjectId(docId) };

    const total = await ReviewModel.countDocuments(filter);
    const query = ReviewModel.find(filter).sort({ version: -1, createdDate: -1 });

    const reviews = latestOnly
      ? await query.limit(1).lean()
      : await query
          .skip((page - 1) * limit)
          .limit(limit)
          .lean();

    return applyTempUserHeaders(
      NextResponse.json({
        total,
        page,
        limit,
        reviews: reviews.map((r) => ({
          id: String(r._id),
          docId: String(r.docId),
          uploadId: r.uploadId ? String(r.uploadId) : null,
          version: Number.isFinite(r.version) ? r.version : null,
          status: r.status ?? null,
          model: r.model ?? null,
          priorReviewVersion: Number.isFinite(r.priorReviewVersion)
            ? r.priorReviewVersion
            : null,
          outputMarkdown: r.outputMarkdown ?? null,
          intel: (function () {
            const intel = (r as unknown as { intel?: unknown }).intel;
            return intel && typeof intel === "object" ? intel : null;
          })(),
          agentKind:
            typeof (r as unknown as { agentKind?: unknown }).agentKind === "string"
              ? ((r as unknown as { agentKind: string }).agentKind ?? null)
              : null,
          agentOutput: (function () {
            const out = (r as unknown as { agentOutput?: unknown }).agentOutput;
            return out && typeof out === "object" ? out : null;
          })(),
          createdDate: r.createdDate ? new Date(r.createdDate).toISOString() : null,
          updatedDate: r.updatedDate ? new Date(r.updatedDate).toISOString() : null,
        })),
      }),
      actor,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs/:docId/reviews] GET failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}




