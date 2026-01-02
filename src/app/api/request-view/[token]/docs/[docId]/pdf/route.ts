/**
 * Same-origin PDF proxy for request repo viewing links.
 *
 * Route: `/api/request-view/:token/docs/:docId/pdf`
 *
 * This is a view-only capability endpoint authorized by `Project.requestViewToken`.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";

export const runtime = "nodejs";

function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
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

export async function GET(
  request: Request,
  ctx: { params: Promise<{ token: string; docId: string }> },
) {
  const { token, docId } = await ctx.params;
  const viewToken = decodeURIComponent(token || "").trim();
  if (!viewToken) return NextResponse.json({ error: "Missing token" }, { status: 400 });
  if (!isObjectId(docId)) return NextResponse.json({ error: "Invalid docId" }, { status: 400 });

  await connectMongo();

  const project = await ProjectModel.findOne({ requestViewToken: viewToken })
    .select({ _id: 1 })
    .lean();
  if (!project?._id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const doc = await DocModel.findOne({
    _id: new Types.ObjectId(docId),
    receivedViaRequestProjectId: project._id,
    isDeleted: { $ne: true },
  })
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

  // Tokenized capability URL; keep caching private (URL can be shared).
  headers.set("cache-control", "private, max-age=3600");

  const filename = safePdfFilename(
    (doc as { fileName?: unknown }).fileName as string | null | undefined ??
      ((doc as { title?: unknown }).title as string | null | undefined),
  );
  headers.set("content-disposition", `inline; filename="${filename}"`);

  return new Response(upstream.body, {
    status: upstream.status,
    headers,
  });
}




