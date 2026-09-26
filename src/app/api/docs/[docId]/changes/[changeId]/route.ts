/**
 * API route for `/api/docs/:docId/changes/:changeId`.
 *
 * Fetch a single change record (including large text fields) for on-demand viewing in History.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { buildDocMatch } from "@/lib/docs/docMatch";
import { lockedHomeExclusionFor } from "@/lib/projects/lockScope";
import { DocChangeModel } from "@/lib/models/DocChange";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}

export async function GET(
  request: Request,
  ctx: { params: Promise<{ docId: string; changeId: string }> },
) {
  try {
    const actor = await resolveActor(request);
    const { docId, changeId } = await ctx.params;
    if (!isObjectId(docId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }
    if (!isObjectId(changeId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid changeId" }, { status: 400 }), actor);
    }

    await connectMongo();

    // Authorization: doc must belong to the actor's org (with legacy personal-org fallback), and its
    // home must not be a locked room this person holds no grant for. The lock is access rather than
    // discovery (docs/prds/lnkdrp-locked-projects.md, decision 11), so it is this by-id check and not
    // a listing filter that keeps a pasted document id out of a private room.
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const lockedExclusion = await lockedHomeExclusionFor(orgId, actor.userId, request);
    const docObjectId = new Types.ObjectId(docId);
    const docExists = await DocModel.exists(buildDocMatch(docObjectId, orgId, legacyUserId, allowLegacyByUserId, lockedExclusion));
    if (!docExists) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const change = await DocChangeModel.findOne({
      _id: new Types.ObjectId(changeId),
      docId: docObjectId,
    })
      .select({ _id: 1, docId: 1, previousText: 1, newText: 1 })
      .lean();

    if (!change) return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);

    return applyTempUserHeaders(
      NextResponse.json(
        {
          ok: true,
          docId,
          change: {
            id: String(change._id),
            docId: change.docId ? String(change.docId) : docId,
            previousText: typeof (change as any).previousText === "string" ? (change as any).previousText : "",
            newText: typeof (change as any).newText === "string" ? (change as any).newText : "",
          },
        },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    const actor = await resolveActor(request).catch(() => null);
    const message = err instanceof Error ? err.message : "Unknown error";
    const res = NextResponse.json({ error: message }, { status: 400 });
    return actor ? applyTempUserHeaders(res, actor) : res;
  }
}


