// Route: POST /api/auth/claim-temp - migrate a temp user's docs/uploads to the signed-in user.
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { UserModel, verifyTempUserSecret } from "@/lib/models/User";
import { ShareLinkModel } from "@/lib/models/ShareLink";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";

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

    /**
     * The workspace moves with the owner, or the document is lost and its link cannot be revoked.
     *
     * This used to set `userId` alone. But a temp visitor's document is stamped with the *temp
     * user's personal org* (`POST /api/docs`), and `ensureDefaultLink` publishes its share link in
     * that same org — so after signing in, every owner-side query missed it. `buildDocMatch` and
     * the share-link helpers are all org-scoped, with a legacy fallback that only matches rows
     * whose `orgId` is absent or null; a row carrying a *non-null temp* org matched none of them.
     *
     * The document vanished from the dashboard and could not be opened, edited, deleted or
     * un-shared — while `resolveShareLink` matches on the slug alone and kept serving the PDF to
     * anyone holding the URL. The temp user row is deleted two lines below, so nothing could ever
     * reach those rows again: a permanent public link to a private document, with no owner.
     *
     * Scoped to the temp org on purpose. `{ userId: tmpUserId }` alone would also catch rows the
     * visitor somehow has in another workspace, and moving those would be a second bug.
     */
    const personal = await ensurePersonalOrgForUserId({ userId: realUserId });
    const realOrgId = personal.orgId;

    // Which documents are moving, read before the update so the links can follow them.
    // `ShareLink` has no `userId` — it is keyed by `orgId` and `docId` — so matching links by the
    // temp user would have been a silent no-op.
    const movingDocs = (await DocModel.find({ userId: tmpUserId }).select({ _id: 1 }).lean()) as Array<{
      _id: Types.ObjectId;
    }>;
    const movingDocIds = movingDocs.map((d) => d._id);

    const [docsRes, uploadsRes] = await Promise.all([
      DocModel.updateMany({ userId: tmpUserId }, { $set: { userId: realUserId, orgId: realOrgId } }),
      UploadModel.updateMany({ userId: tmpUserId }, { $set: { userId: realUserId, orgId: realOrgId } }),
    ]);

    // The links follow their documents. `archiveShareLink`, `setDefaultShareLink` and
    // `listShareLinks` all take an orgId, so a link left in the temp org is one the new owner can
    // watch being served and never turn off.
    const linksRes = movingDocIds.length
      ? await ShareLinkModel.updateMany({ docId: { $in: movingDocIds } }, { $set: { orgId: realOrgId } })
      : { modifiedCount: 0 };

    // Best-effort: remove the temp user record after claiming.
    await UserModel.deleteOne({ _id: tmpUserId, isTemp: true }).catch(() => void 0);

    return NextResponse.json({
      ok: true,
      migrated: {
        docs: (docsRes as { modifiedCount?: unknown }).modifiedCount ?? null,
        uploads: (uploadsRes as { modifiedCount?: unknown }).modifiedCount ?? null,
        shareLinks: (linksRes as { modifiedCount?: unknown }).modifiedCount ?? null,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}






