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
    // Log the actual error server-side but return a generic message to avoid leaking implementation details
    if (process.env.NODE_ENV !== "production") {
      console.error("[api/download/:token] GET error:", err);
    }
    return NextResponse.json({ error: "Failed to fetch document" }, { status: 400 });
  }
}

