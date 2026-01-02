import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { DocReportModel } from "@/lib/models/DocReport";
import { debugError, debugLog } from "@/lib/debug";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";

export const runtime = "nodejs";
/**
 * Handle POST requests.
 */


export async function POST(
  request: Request,
  ctx: { params: Promise<{ docId: string }> },
) {
  try {
    const { docId } = await ctx.params;
    if (!Types.ObjectId.isValid(docId)) {
      return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
    }

    debugLog(1, "[api/docs/:docId/report] POST", { docId });
    const actor = await resolveActor(request);
    const body = (await request.json().catch(() => ({}))) as Partial<{ message: string }>;
    const message = typeof body.message === "string" ? body.message.trim() : "";

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const exists = await DocModel.exists({
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
    if (!exists) return NextResponse.json({ error: "Not found" }, { status: 404 });

    await DocReportModel.create({
      userId: new Types.ObjectId(actor.userId),
      docId: new Types.ObjectId(docId),
      message,
    });

    return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/docs/:docId/report] POST failed", { message });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}






