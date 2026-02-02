/**
 * API route: GET `/api/download/:token/pdf`
 *
 * Authenticated PDF download for an approved download claim token.
 * This bypasses `doc.shareAllowPdfDownload` (the owner explicitly approved this requester).
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

function pickHeader(src: Headers, dst: Headers, name: string, opts?: { fallback?: string }) {
  const v = src.get(name);
  if (typeof v === "string" && v) {
    dst.set(name, v);
    return;
  }
  if (opts?.fallback) dst.set(name, opts.fallback);
}

function safePdfFilename(input: string | null | undefined): string {
  const base = (input ?? "").toString().trim() || "document";
  const cleaned = base
    .replace(/[\/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const withExt = cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
  return withExt || "document.pdf";
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
    const reqDoc = await ShareDownloadRequestModel.findOne({ claimTokenHash, status: "approved" })
      .select({ requesterEmail: 1, docId: 1 })
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
      .select({ blobUrl: 1, title: 1, fileName: 1 })
      .lean();
    if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const blobUrl = (doc as { blobUrl?: unknown }).blobUrl;
    if (typeof blobUrl !== "string" || !blobUrl) {
      return NextResponse.json({ error: "PDF not available" }, { status: 404 });
    }

    const range = request.headers.get("range");
    const upstream = await fetch(blobUrl, {
      headers: range ? { range } : undefined,
      cache: "no-store",
    });

    const headers = new Headers();
    pickHeader(upstream.headers, headers, "content-type", { fallback: "application/pdf" });
    pickHeader(upstream.headers, headers, "content-length");
    pickHeader(upstream.headers, headers, "content-range");
    pickHeader(upstream.headers, headers, "accept-ranges");
    pickHeader(upstream.headers, headers, "etag");
    pickHeader(upstream.headers, headers, "last-modified");
    headers.set("cache-control", "private, max-age=3600");

    const filename = safePdfFilename(
      (doc as { fileName?: unknown }).fileName as string | null | undefined ??
        ((doc as { title?: unknown }).title as string | null | undefined),
    );
    headers.set("content-disposition", `attachment; filename="${filename}"`);

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

