/**
 * API route: `GET /api/docs/:docId/contributors`
 *
 * Who created this document and who has worked on it since. Owner-facing only — this names people
 * in the workspace, so it is scoped to the actor's org the same way every other doc route is, and a
 * document the actor cannot already open returns 404 rather than an empty list. A 403 here would
 * confirm the document exists to somebody who has no business knowing that.
 *
 * The answer is derived, not stored: `loadAuthorship` reads the activity log, which already records
 * every action with its actor. Nothing is written by this route.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { loadAuthorship } from "@/lib/people/contributors";
import { debugError } from "@/lib/debug";

export const dynamic = "force-dynamic";

export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const { docId } = await ctx.params;
  if (!docId || !Types.ObjectId.isValid(docId)) {
    return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
  }

  const actor = await resolveActor(request);
  if (!actor?.orgId || !Types.ObjectId.isValid(actor.orgId)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);

    /**
     * Pre-workspace documents carry no `orgId` and belong to their owner's personal workspace —
     * the same allowance every sibling doc route makes, and without it this 404s on exactly the
     * oldest documents, which are the ones with the most history worth attributing.
     */
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const doc = (await DocModel.findOne(
      allowLegacyByUserId
        ? {
            $or: [
              { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } },
              {
                _id: new Types.ObjectId(docId),
                isDeleted: { $ne: true },
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
                userId: new Types.ObjectId(actor.userId),
              },
            ],
          }
        : { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } },
    )
      .select({ _id: 1, orgId: 1, userId: 1 })
      .lean()) as { orgId?: unknown; userId?: unknown } | null;

    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const authorship = await loadAuthorship({
      orgId: doc.orgId ? String(doc.orgId) : actor.orgId,
      creatorUserId: doc.userId ? String(doc.userId) : null,
      scope: { docId },
    });

    const res = NextResponse.json(authorship);
    applyTempUserHeaders(res, actor);
    return res;
  } catch (err) {
    debugError(1, "[docs/contributors] failed", {
      docId,
      message: err instanceof Error ? err.message : String(err),
    });
    // The card is an aid; a failure here must not take the document page with it.
    return NextResponse.json({ author: null, contributors: [] });
  }
}
