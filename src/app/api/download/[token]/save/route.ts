/**
 * API route: POST `/api/download/:token/save`
 *
 * Authenticated endpoint to save an approved shared doc into the signed-in user's account.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { connectMongo } from "@/lib/mongodb";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { UserModel } from "@/lib/models/User";
import { DocModel } from "@/lib/models/Doc";
import { shareLinkUnlocked } from "@/lib/share/links";
import { resolveClaimLink } from "@/lib/share/claimLink";
import { newShareId } from "@/lib/crypto/randomBase62";

export const runtime = "nodejs";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const actor = await resolveActor(request);
    if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    /**
     * "Save to my account" ends in `DocModel.create` below, so it is a document-creating path and
     * answers to the same role check as every other one (`POST /api/docs`, the upload routes).
     * This handler proved only that the caller's address matches `requesterEmail` — which is who
     * the *document* was approved for, not what they may do in the workspace they happen to be
     * sitting in. A `viewer` is read-only by definition (see requireOrgEditor), and without this
     * they could write a row into a shared workspace they are only allowed to read.
     *
     * Scoped to the active workspace, so it refuses the destination rather than the claim: a
     * viewer in a team workspace who owns another one switches workspace and saves there, and the
     * 403 body from `requireOrgRole` is what the claim page renders.
     *
     * Deliberately no `checkLimit(actor.orgId, "documents")` beside it, unlike POST /api/docs. The
     * Free cap counts *shared* documents (`getWorkspaceUsage` filters `shareEnabled: { $ne: false }`)
     * and the row below is created `shareEnabled: false`, so the saved copy adds nothing to the
     * count. Checking here would refuse a claim the recipient is entitled to because of other
     * documents that this one does not touch.
     */
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;

    const { token } = await ctx.params;
    const rawToken = decodeURIComponent(token ?? "").trim();
    if (!rawToken) return NextResponse.json({ error: "Missing token" }, { status: 400 });

    await connectMongo();
    const claimTokenHash = sha256Hex(rawToken);
    const reqDoc = await ShareDownloadRequestModel.findOne({ claimTokenHash, status: "approved" })
      .select({ requesterEmail: 1, docId: 1, savedDocId: 1, shareId: 1 })
      .lean();
    if (!reqDoc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const u = await UserModel.findOne({ _id: new Types.ObjectId(actor.userId) }).select({ email: 1 }).lean();
    const email = typeof (u as { email?: unknown } | null)?.email === "string" ? String((u as { email: string }).email) : "";
    const requesterEmail =
      typeof (reqDoc as { requesterEmail?: unknown }).requesterEmail === "string"
        ? String((reqDoc as { requesterEmail: string }).requesterEmail).trim().toLowerCase()
        : "";
    if (!email || !requesterEmail || email.trim().toLowerCase() !== requesterEmail) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }

    const existingSaved = (reqDoc as { savedDocId?: unknown }).savedDocId;
    if (existingSaved && Types.ObjectId.isValid(String(existingSaved))) {
      return NextResponse.json({ ok: true, docId: String(existingSaved), kind: "already_saved" as const });
    }

    const sourceDocId = (reqDoc as { docId?: unknown }).docId;
    // Saving a copy is a download by another name, so it answers to the same link gate: a disabled,
    // expired or archived link must not keep handing out the file to an approved requester.
    const shareIdOfRequest = typeof (reqDoc as { shareId?: unknown }).shareId === "string" ? String((reqDoc as { shareId: string }).shareId) : "";
    const resolvedLink = shareIdOfRequest ? await resolveClaimLink(shareIdOfRequest, (reqDoc as { docId?: unknown }).docId as string | undefined ?? "") : null;
    if (!resolvedLink || resolvedLink.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });

    // ...and to the same password gate as the download, for the stronger reason: this one leaves a
    // permanent Doc in the claimer's own workspace pointing at the same blob, so a copy taken
    // without the password outlives every control the owner still has over the link.
    // The cookie is named for the slug the recipient visited — the one stored on the request row.
    if (!shareLinkUnlocked(request, shareIdOfRequest, resolvedLink.link)) {
      return NextResponse.json(
        // The sentence goes in `error`: that is the field `fetchJson` shows the person, and the
        // claim page renders it verbatim. It has to say what to do, because the fix is theirs.
        { error: `This link is password protected. Open /s/${resolvedLink.link.shareId}, enter the password, then try again.` },
        { status: 401 },
      );
    }

    const src = await DocModel.findOne({ _id: sourceDocId, isDeleted: { $ne: true }, isArchived: { $ne: true } })
      .select({ title: 1, fileName: 1, blobUrl: 1, previewImageUrl: 1, firstPagePngUrl: 1 })
      .lean();
    if (!src) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const title = typeof (src as { title?: unknown }).title === "string" ? String((src as { title: string }).title) : "Shared document";
    const blobUrl = (src as { blobUrl?: unknown }).blobUrl;
    const fileName = typeof (src as { fileName?: unknown }).fileName === "string" ? String((src as { fileName: string }).fileName) : null;
    const previewImageUrl =
      typeof (src as { previewImageUrl?: unknown }).previewImageUrl === "string"
        ? String((src as { previewImageUrl: string }).previewImageUrl)
        : null;
    const firstPagePngUrl =
      typeof (src as { firstPagePngUrl?: unknown }).firstPagePngUrl === "string"
        ? String((src as { firstPagePngUrl: string }).firstPagePngUrl)
        : null;

    // Create a new personal/active-org doc that references the same PDF blob.
    // Security: keep it unshared by default.
    const created = await DocModel.create({
      orgId: new Types.ObjectId(actor.orgId),
      userId: new Types.ObjectId(actor.userId),
      title,
      fileName,
      blobUrl: typeof blobUrl === "string" ? blobUrl : null,
      previewImageUrl,
      firstPagePngUrl,
      status: typeof blobUrl === "string" && blobUrl ? "ready" : "draft",
      shareId: newShareId(),
      shareEnabled: false,
      shareAllowPdfDownload: false,
      receiverRelevanceChecklist: false,
    });
    const createdDoc = Array.isArray(created) ? created[0] : created;

    await ShareDownloadRequestModel.updateOne(
      { _id: (reqDoc as { _id: unknown })._id },
      { $set: { savedDocId: createdDoc._id, savedAt: new Date() } },
    );

    return NextResponse.json({ ok: true, kind: "saved" as const, docId: String(createdDoc._id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

