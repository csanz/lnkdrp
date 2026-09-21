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
import { fetchStoredBlob } from "@/lib/blob/fetchStoredBlob";

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

  // A deleted request repo has to stop answering for its own token. Deleting the repo is the
  // owner's way of retiring the whole capability link, and without this clause the token outlived
  // the thing it was a token for.
  const project = await ProjectModel.findOne({
    requestViewToken: viewToken,
    isDeleted: { $ne: true },
  })
    .select({ _id: 1 })
    .lean();
  if (!project?._id) return NextResponse.json({ error: "Not found" }, { status: 404 });

  // `isArchived` belongs here next to `isDeleted`. Archiving is the product's one way to take a
  // received document out of circulation without destroying it — share links already refuse an
  // archived doc (src/lib/share/links.ts resolves it to the "archived" refusal) and the data-room
  // aggregation already filters it out. This route was the one reader that only knew about
  // `isDeleted`, so an owner who archived a sensitive upload was told it was withdrawn while every
  // holder of the request-view link kept streaming the bytes. The listing page carries the same
  // pair of clauses; the two queries must stay in step.
  const doc = await DocModel.findOne({
    _id: new Types.ObjectId(docId),
    receivedViaRequestProjectId: project._id,
    isDeleted: { $ne: true },
    isArchived: { $ne: true },
  })
    .select({ blobUrl: 1, title: 1, fileName: 1 })
    .lean();
  if (!doc) return NextResponse.json({ error: "Not found" }, { status: 404 });

  const blobUrl = (doc as { blobUrl?: unknown }).blobUrl;
  if (typeof blobUrl !== "string" || !blobUrl) {
    return NextResponse.json({ error: "PDF not available" }, { status: 404 });
  }
  // A pointer we will not dereference is the same answer as no pointer — see `blobFetchUrl`.
  // Beside the empty check so the refusal is the document's own 404, not a 500 thrown out of this
  // handler by a `fetch` of a host that does not resolve. The owner sees "PDF not available" on
  // that submission until it is re-uploaded through the validated path.
  const range = request.headers.get("range");
  // `fetchStoredBlob` applies the allowlist to every hop, so a stored URL that redirects off the
  // store is refused rather than followed. It returns null for both "not ours" and "led somewhere
  // that is not ours", which are the same answer from here.
  const upstream = await fetchStoredBlob(blobUrl, { headers: range ? { range } : undefined });
  if (!upstream) return NextResponse.json({ error: "PDF not available" }, { status: 404 });

  const headers = new Headers();
  // Pinned, not copied. These routes serve one thing — the stored PDF — so echoing the upstream
  // `content-type` bought nothing and cost everything: with `content-disposition: inline` and no
  // `script-src` in the app's CSP, an upstream that answered `text/html` made this origin serve
  // attacker markup and script. The write path that made that reachable is closed
  // (`blobUrl` is no longer patchable), and this is the second lock: even a blob the store itself
  // mislabels can only ever be delivered as a PDF.
  headers.set("content-type", "application/pdf");
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




