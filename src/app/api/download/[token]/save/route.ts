/**
 * API route: POST `/api/download/:token/save`
 *
 * Authenticated endpoint to save an approved shared doc into the signed-in user's account.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { resolveActor } from "@/lib/gating/actor";
import { connectMongo } from "@/lib/mongodb";
import { ShareDownloadRequestModel } from "@/lib/models/ShareDownloadRequest";
import { UserModel } from "@/lib/models/User";
import { DocModel } from "@/lib/models/Doc";

export const runtime = "nodejs";

const BASE62_ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";

function sha256Hex(s: string): string {
  return crypto.createHash("sha256").update(s).digest("hex");
}

function randomBase62(length: number): string {
  let out = "";
  while (out.length < length) {
    const remaining = length - out.length;
    const buf = crypto.randomBytes(Math.max(8, Math.ceil(remaining * 1.25)));
    for (const b of buf) {
      if (b < 248) out += BASE62_ALPHABET[b % 62];
      if (out.length >= length) break;
    }
  }
  return out;
}

function newShareId() {
  return randomBase62(12);
}

export async function POST(request: Request, ctx: { params: Promise<{ token: string }> }) {
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
    const reqDoc = await ShareDownloadRequestModel.findOne({ claimTokenHash, status: "approved" })
      .select({ requesterEmail: 1, docId: 1, savedDocId: 1 })
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
    const src = await DocModel.findOne({ _id: sourceDocId, isDeleted: { $ne: true } })
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

