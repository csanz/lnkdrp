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
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { liveProjectByIdMatch } from "@/lib/projects/scope";
import { buildDocMatch } from "@/lib/docs/docMatch";

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

    // A `viewer` seat is the read-only one handed to outside reviewers, and this route decides what
    // the review agent reads as context for every future upload into the repo. The rule is stated
    // once in src/lib/orgs/requireOrgEditor.ts — "every handler that creates or changes workspace
    // data must reject viewer members" — and this handler was simply not following it.
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;

    const body = (await request.json().catch(() => ({}))) as Partial<{ docId: string }>;
    const docId = typeof body.docId === "string" ? body.docId.trim() : "";
    if (!docId || !Types.ObjectId.isValid(docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    /**
     * No locked-room exclusion on this route, and that is decision 25 rather than an oversight.
     *
     * A request inbox can never be locked (decision 10) and its guide document is homed in it, so the
     * clause would be inert; more importantly this is a recipient-facing capability surface, and
     * `tests/lib/lockedProjectRecipients.test.ts` refuses the import outright, because a clause on the
     * inbound half breaks every request link a workspace has already sent.
     */
    const lockedExclusion: Record<string, unknown> = {};

    // Both halves of this filter wanted to be a top-level `$or`, and the second one won — so the
    // workspace bound was deleted before the query was sent, and from a personal workspace (the
    // default state for most accounts) any request repo in any tenant resolved here. `$and` keeps
    // them apart, and `liveProjectByIdMatch` is the same rule the project routes use.
    const project = await ProjectModel.findOne({
      $and: [
        // A request inbox can never be locked (docs/prds/lnkdrp-locked-projects.md, decision 10), so
        // the visibility clause the builder adds matches every row this query can reach. The viewer
        // is threaded through because the builder requires one, not because there is anything here
        // to hide.
        await liveProjectByIdMatch(new Types.ObjectId(requestId), orgId, legacyUserId, allowLegacyByUserId, actor.userId, request),
        {
          $or: [
            { isRequest: true },
            { requestUploadToken: { $exists: true, $nin: [null, ""] } },
          ],
        },
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
          await liveProjectByIdMatch(new Types.ObjectId(requestId), orgId, legacyUserId, allowLegacyByUserId, actor.userId, request),
          { $set: { isRequest: true } },
        );
      }
    } catch {
      // ignore; request behavior should still work based on token existence
    }

    // The same rule the two writes below already use: one shared match, not a third copy of it.
    const doc = await DocModel.findOne(buildDocMatch(new Types.ObjectId(docId), orgId, legacyUserId, allowLegacyByUserId, lockedExclusion))
      .select({ _id: 1 })
      .lean();
    if (!doc) return NextResponse.json({ error: "Doc not found" }, { status: 404 });

    await ProjectModel.updateOne(
      await liveProjectByIdMatch(new Types.ObjectId(requestId), orgId, legacyUserId, allowLegacyByUserId, actor.userId, request),
      { $set: { requestReviewGuideDocId: new Types.ObjectId(docId) } },
    );

    // Link the guide doc back to this request repo (durable doc-level pointer).
    await DocModel.updateOne(
      buildDocMatch(new Types.ObjectId(docId), orgId, legacyUserId, allowLegacyByUserId, lockedExclusion),
      { $set: { guideForRequestProjectId: new Types.ObjectId(requestId) } },
    );

    // Best-effort cleanup: if we replaced an existing guide doc for this request,
    // clear its backlink so old guide docs don't keep showing request context.
    if (prevGuideDocId && String(prevGuideDocId) !== String(docId)) {
      await DocModel.updateOne(
        {
          $and: [
            buildDocMatch(new Types.ObjectId(String(prevGuideDocId)), orgId, legacyUserId, allowLegacyByUserId, lockedExclusion),
            { guideForRequestProjectId: new Types.ObjectId(requestId) },
          ],
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


