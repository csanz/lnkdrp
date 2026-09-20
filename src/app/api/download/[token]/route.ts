/**
 * API route: GET `/api/download/:token`
 *
 * Authenticated endpoint for an approved download claim link.
 * Returns basic metadata needed by the `/download/:token` UI.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { UserModel } from "@/lib/models/User";
import { DocModel } from "@/lib/models/Doc";
import { resolveShareLink, shareLinkUnlocked } from "@/lib/share/links";
import { debugError } from "@/lib/debug";

export const runtime = "nodejs";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

export async function GET(request: Request, ctx: { params: Promise<{ token: string }> }) {
  try {
    const actor = await resolveActor(request);
    if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.userId)) {
      return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
    }

    const { token } = await ctx.params;
    const rawToken = decodeURIComponent(token ?? "").trim();
    if (!rawToken) return NextResponse.json({ error: "Missing token" }, { status: 400 });

    await connectMongo();
    const claimTokenHash = sha256Hex(rawToken);
    const reqDoc = await ShareDownloadRequestModel.findOne({
      claimTokenHash,
      status: "approved",
    })
      .select({ requesterEmail: 1, docId: 1, shareId: 1 })
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

    // The same two gates the bytes are behind (`./pdf`, `./save`), asked here so the claim page can
    // say so before the person clicks: an approval is permission through *that link*, and a
    // password-protected link still wants the password. Answering "ready to download" and then
    // refusing at the click is how a recipient learns to distrust the product instead of the link.
    const shareIdOfRequest = typeof (reqDoc as { shareId?: unknown }).shareId === "string" ? String((reqDoc as { shareId: string }).shareId) : "";
    const resolved = shareIdOfRequest ? await resolveShareLink(shareIdOfRequest) : null;
    if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
    // The cookie is named for the slug the recipient visited — the one stored on the request row.
    if (!shareLinkUnlocked(request, shareIdOfRequest, resolved.link)) {
      return NextResponse.json(
        { error: `This link is password protected. Open /s/${resolved.link.shareId}, enter the password, then open this link again.` },
        { status: 401 },
      );
    }

    const docId = (reqDoc as { docId?: unknown }).docId;
    const doc = await DocModel.findOne({ _id: docId, isDeleted: { $ne: true } })
      .select({ title: 1 })
      .lean();
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const title = typeof (doc as { title?: unknown }).title === "string" ? String((doc as { title: string }).title) : "Shared document";

    return NextResponse.json({
      ok: true,
      doc: {
        title,
      },
    });
  } catch (err) {
    debugError(1, "[api/download/:token] GET error", { message: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ error: "Failed to fetch document" }, { status: 400 });
  }
}

