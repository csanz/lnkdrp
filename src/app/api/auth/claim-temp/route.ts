// Route: POST /api/auth/claim-temp - migrate a temp user's docs/uploads to the signed-in user.
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { UserModel, verifyTempUserSecret } from "@/lib/models/User";

export const runtime = "nodejs";
/**
 * Handle POST requests.
 */


export async function POST(request: Request) {
  try {
    const actor = await resolveActor(request);
    const userId = actor.kind === "user" ? actor.userId : null;
    if (!userId || !Types.ObjectId.isValid(userId)) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const body = (await request.json().catch(() => ({}))) as Partial<{
      tempUserId: string;
      tempUserSecret: string;
    }>;

    const tempUserId = (body.tempUserId ?? "").trim();
    const tempUserSecret = (body.tempUserSecret ?? "").trim();
    if (!Types.ObjectId.isValid(tempUserId) || !tempUserSecret) {
      return NextResponse.json({ ok: true, skipped: true });
    }

    await connectMongo();

    const temp = await UserModel.findOne({
      _id: new Types.ObjectId(tempUserId),
      isTemp: true,
    })
      .select({ _id: 1, tempSecretHash: 1 })
      .lean();

    if (
      !temp ||
      !verifyTempUserSecret({
        secret: tempUserSecret,
        secretHash: temp.tempSecretHash ?? null,
      })
    ) {
      // Don’t leak whether the temp user exists.
      return NextResponse.json({ ok: true, skipped: true });
    }

    const realUserId = new Types.ObjectId(userId);
    const tmpUserId = new Types.ObjectId(tempUserId);

    const [docsRes, uploadsRes] = await Promise.all([
      DocModel.updateMany({ userId: tmpUserId }, { $set: { userId: realUserId } }),
      UploadModel.updateMany({ userId: tmpUserId }, { $set: { userId: realUserId } }),
    ]);

    // Best-effort: remove the temp user record after claiming.
    await UserModel.deleteOne({ _id: tmpUserId, isTemp: true }).catch(() => void 0);

    return NextResponse.json({
      ok: true,
      migrated: {
        docs: (docsRes as { modifiedCount?: unknown }).modifiedCount ?? null,
        uploads: (uploadsRes as { modifiedCount?: unknown }).modifiedCount ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}






