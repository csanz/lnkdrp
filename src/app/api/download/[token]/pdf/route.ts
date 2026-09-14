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
import { ShareViewModel } from "@/lib/models/ShareView";
import { resolveShareLink, touchShareLink } from "@/lib/share/links";
import { recordActivity } from "@/lib/activity/log";

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

    // An approval is permission to download *through that link*, not a standing right to the file.
    // Without this the owner could disable, expire or archive the link and an approved requester
    // would keep downloading: the claim token went straight to the document and never consulted
    // the link. Same gate the public `/s/:shareId/pdf` route applies.
    const shareIdOfRequest = typeof (reqDoc as { shareId?: unknown }).shareId === "string" ? String((reqDoc as { shareId: string }).shareId) : "";
    const resolved = shareIdOfRequest ? await resolveShareLink(shareIdOfRequest) : null;
    if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const doc = await DocModel.findOne({ _id: docId, isDeleted: { $ne: true }, isArchived: { $ne: true } })
      .select({ blobUrl: 1, title: 1, fileName: 1, userId: 1, orgId: 1 })
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

    // The owner asked to be told when this person downloads; before, an approved download was
    // invisible in both the link's counters and the activity feed.
    if (upstream.ok) {
      void touchShareLink(resolved.link.shareId, "download");
      // ...and record it on the analytics rows, which are what every surface now counts. Touching
      // only the link's counter made `ShareLink.downloadCount` read 4 where the rows summed to 3,
      // and pushed the link's "Last viewed" ahead of any view that had actually happened. Both
      // showed up the moment `scripts/verify-share-analytics.ts` compared the two.
      //
      // A claim-link download has no `botId` — there is no share page in this flow — so the viewer
      // key is derived from who was approved. That gives one row per approved requester per link,
      // which is the same unit `/s/:shareId/pdf` produces for a browser.
      void (async () => {
        try {
          const identity = actor.userId || requesterEmail || "";
          if (!identity) return;
          const botIdHash = crypto.createHash("sha256").update(`dlreq:${identity}`).digest("hex");
          const day = new Date().toISOString().slice(0, 10);
          await ShareViewModel.updateOne(
            { shareId: resolved.link.shareId, botIdHash },
            {
              $setOnInsert: { shareId: resolved.link.shareId, docId, botIdHash, pagesSeen: [] },
              $set: {
                shareLinkId: resolved.link._id,
                ...((doc as { orgId?: unknown }).orgId ? { orgId: new Types.ObjectId(String((doc as { orgId: unknown }).orgId)) } : {}),
                ...(requesterEmail ? { viewerEmail: requesterEmail, viewerEmailSnapshot: requesterEmail } : {}),
                ...(actor.userId && Types.ObjectId.isValid(actor.userId) ? { viewerUserId: new Types.ObjectId(actor.userId) } : {}),
                lastViewedAt: new Date(),
              },
              $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
            },
            { upsert: true },
          );
        } catch {
          // Best-effort: never fail a download the owner already approved.
        }
      })();
      const orgIdForActivity = (doc as { orgId?: unknown }).orgId ? String((doc as { orgId: unknown }).orgId) : null;
      if (orgIdForActivity) {
        void recordActivity({
          orgId: orgIdForActivity,
          userId: actor.userId,
          actorKind: "viewer",
          type: "share.downloaded",
          docId: String(docId),
          title: typeof (doc as { title?: unknown }).title === "string" ? String((doc as { title: string }).title) : null,
          meta: {
            shareId: resolved.link.shareId,
            linkLabel: resolved.link.label ?? null,
            isDefaultLink: Boolean(resolved.link.isDefault),
            viewerEmail: requesterEmail,
            viaDownloadRequest: true,
          },
          request,
        });
      }
    }

    return new Response(upstream.body, { status: upstream.status, headers });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}

