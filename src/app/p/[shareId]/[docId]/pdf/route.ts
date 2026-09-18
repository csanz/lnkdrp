/**
 * Same-origin PDF proxy for a document opened through a project link: `/p/:shareId/:docId/pdf`.
 *
 * The project-link twin of `/s/:shareId/pdf`, and a separate route rather than a branch inside that
 * one because the two differ on the only three things the route does: which link authorises the
 * request (this one's `allowDownload`, never the document's), which analytics row a download lands
 * on (`projectViewerKey`, so three documents behind one link do not collide on `{shareId,
 * botIdHash}`), and the extra `ProjectLinkView` counter a project landing owns.
 *
 * Everything else is deliberately identical, including the parts that are easy to get wrong and
 * were got wrong once already on the document route: the owner side is resolved **before** any
 * counter moves (an owner downloading their own deck must not bump the link's `downloadCount` or
 * write "Someone downloaded this" into their own feed), a duplicate-key race still increments, and
 * Range requests pass through untouched because pdf.js depends on them.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import crypto from "node:crypto";

import { recordActivity } from "@/lib/activity/log";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { ProjectLinkViewModel } from "@/lib/models/ProjectLinkView";
import { ShareViewModel } from "@/lib/models/ShareView";
import { touchShareLink } from "@/lib/share/links";
import { isOwnerSideViewer } from "@/lib/share/ownerSide";
import { projectLinkPasswordEnabled, projectViewerKey, resolveProjectDocument } from "@/lib/share/projectPublic";
import { shareAuthCookieName, shareAuthCookieValue } from "@/lib/sharePassword";
import { clientIpFromRequest } from "@/lib/http/rateLimit";
import { tryResolveAuthUserId } from "@/lib/gating/actor";

export const runtime = "nodejs";

function utcDayKey(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/** Minimal cookie read: the share-auth value is opaque hex and needs no decoding. */
function getCookie(request: Request, name: string): string | null {
  const raw = request.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const [k, ...rest] = part.trim().split("=");
    if (k === name) return rest.join("=") || "";
  }
  return null;
}

/** Copy an upstream header through, or fall back. */
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
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 120);
  const withExt = cleaned.toLowerCase().endsWith(".pdf") ? cleaned : `${cleaned}.pdf`;
  return withExt || "document.pdf";
}

/** Activity feed: "downloaded", carrying the project so the feed can say which data room it was. */
async function recordProjectDownloadActivity(input: {
  doc: Record<string, unknown>;
  projectId: string;
  projectName: string | null;
  shareId: string;
  viewKey: string;
  request: Request;
  link: { label: string | null; isDefault: boolean };
  viewer: { userId: string | null };
}) {
  try {
    const ownerUserId = input.doc.userId ? new Types.ObjectId(String(input.doc.userId)) : null;
    const orgId = input.doc.orgId
      ? String(input.doc.orgId)
      : ownerUserId
        ? String((await ensurePersonalOrgForUserId({ userId: ownerUserId })).orgId)
        : null;
    if (!orgId) return;
    // Attribution only: an unnamed row beats a missing one, so the lookup may fail silently.
    const known = (await ShareViewModel.findOne({ shareId: input.shareId, botIdHash: input.viewKey })
      .select({ viewerName: 1, viewerEmail: 1 })
      .lean()
      .catch(() => null)) as { viewerName?: string | null; viewerEmail?: string | null } | null;
    await recordActivity({
      orgId,
      userId: input.viewer.userId,
      actorKind: "viewer",
      type: "share.downloaded",
      docId: String(input.doc._id),
      title: typeof input.doc.title === "string" ? input.doc.title : null,
      meta: {
        shareId: input.shareId,
        linkLabel: input.link.label,
        isDefaultLink: input.link.isDefault,
        // The composite key, so the feed's `viewerKey` join finds the row it names (the lookup is
        // `ShareView.findOne({ shareId, botIdHash: viewerKey })`).
        viewerKey: input.viewKey,
        viewerName: known?.viewerName ?? null,
        viewerEmail: known?.viewerEmail ?? null,
        // New for project links: which data room the download happened in.
        projectId: input.projectId,
        projectName: input.projectName,
      },
      request: input.request,
    });
  } catch {
    // best-effort
  }
}

export async function GET(request: Request, ctx: { params: Promise<{ shareId: string; docId: string }> }) {
  const { shareId, docId } = await ctx.params;
  if (!shareId || !docId) return NextResponse.json({ error: "Missing shareId" }, { status: 400 });

  const url = new URL(request.url);
  const wantsDownload = url.searchParams.get("download") === "1";
  const botId = url.searchParams.get("botId");
  const viewerIp = clientIpFromRequest(request) || null;

  // Membership is re-proved here, not trusted from the URL: this route hands out bytes.
  const resolved = await resolveProjectDocument(shareId, docId, { select: { blobUrl: 1, title: 1, fileName: 1, orgId: 1, userId: 1 } });
  if (!resolved || resolved.refusal) return NextResponse.json({ error: "Not found" }, { status: 404 });
  const { link, project, doc } = resolved;

  const blobUrl = typeof doc.blobUrl === "string" ? doc.blobUrl : "";
  if (!blobUrl) return NextResponse.json({ error: "PDF not available" }, { status: 404 });

  if (projectLinkPasswordEnabled(link)) {
    const cookie = getCookie(request, shareAuthCookieName(shareId)) ?? "";
    const expected = shareAuthCookieValue({ shareId, sharePasswordHash: link.passwordHash as string });
    if (!cookie || cookie !== expected) return new Response("Unauthorized", { status: 401 });
  }

  // PRD decision 3: the project link's flag governs every document opened through it. A document
  // whose own link allows downloads is still not downloadable to *this* audience unless the sender
  // said so on this link.
  if (wantsDownload && !link.allowDownload) return new Response("Download disabled", { status: 403 });

  const downloadSession = wantsDownload ? await tryResolveAuthUserId(request) : null;
  const ownerPreview = wantsDownload ? await isOwnerSideViewer(doc as { orgId?: unknown; userId?: unknown }, downloadSession?.userId ?? null) : false;

  if (wantsDownload && typeof botId === "string" && botId.trim()) {
    const botIdHash = crypto.createHash("sha256").update(botId.trim()).digest("hex");
    // One row per (link, viewer, document) — see `projectViewerKey` for why the document is carried
    // inside the key rather than beside it.
    const viewKey = projectViewerKey(botIdHash, doc._id);
    const day = utcDayKey(new Date());
    const docOrgId = doc.orgId ? new Types.ObjectId(String(doc.orgId)) : null;
    try {
      const dl = await ShareViewModel.updateOne(
        { shareId, botIdHash: viewKey },
        {
          $setOnInsert: { shareId, docId: doc._id, botIdHash: viewKey, pagesSeen: [] },
          $set: {
            shareLinkId: link._id,
            ...(docOrgId ? { orgId: docOrgId } : {}),
            ...(viewerIp ? { viewerIp } : {}),
            isOwnerPreview: ownerPreview,
            lastViewedAt: new Date(),
          },
          $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
        },
        { upsert: true },
      );
      // A `ShareView` row is a view everywhere downstream, so a download from a device we have
      // never seen has to move what a first view moves — but on **this** route that is a project
      // link, and a read through a project link is the project's view, not the document's
      // (docs/METRICS.md, `@/lib/analytics/docScope`). The link's own counter moves; the
      // document's `numberOfViews` deliberately does not, because no document-scoped figure counts
      // this row.
      if ((dl as { upsertedCount?: number })?.upsertedCount && !ownerPreview) {
        void touchShareLink(shareId, "view", { countView: true });
      }
      if (!ownerPreview) void touchShareLink(shareId, "download");
    } catch {
      // Duplicate-key race: retry the increments without the upsert, so the counters survive
      // exactly the collision they were meant to survive.
      try {
        await ShareViewModel.updateOne(
          { shareId, botIdHash: viewKey },
          {
            $set: { shareLinkId: link._id, ...(viewerIp ? { viewerIp } : {}), isOwnerPreview: ownerPreview, lastViewedAt: new Date() },
            $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
          },
        );
        if (!ownerPreview) void touchShareLink(shareId, "download");
      } catch {
        // Never block a download on tracking.
      }
    }

    // The landing row owns "downloads taken through this link", across every document in the
    // project — the figure a data-room sender actually asks for. Keyed on the bare `botIdHash`:
    // this row is about the person, not the document.
    try {
      await ProjectLinkViewModel.updateOne(
        { shareId, botIdHash },
        {
          $setOnInsert: { shareId, projectId: project._id, botIdHash, firstViewedAt: new Date() },
          $set: {
            shareLinkId: link._id,
            ...(project.orgId ? { orgId: project.orgId } : {}),
            ...(viewerIp ? { viewerIp } : {}),
            isOwnerPreview: ownerPreview,
            lastViewedAt: new Date(),
          },
          $addToSet: { docsOpened: doc._id },
          $inc: { downloads: 1, [`downloadsByDay.${day}`]: 1 },
        },
        { upsert: true },
      );
    } catch {
      // best-effort
    }

    if (!ownerPreview) {
      void recordProjectDownloadActivity({
        doc: doc as Record<string, unknown>,
        projectId: String(project._id),
        projectName: typeof project.name === "string" ? project.name : null,
        shareId,
        viewKey,
        request,
        link: { label: link.label ?? null, isDefault: Boolean(link.isDefault) },
        viewer: { userId: downloadSession?.userId ? String(downloadSession.userId) : null },
      });
    }
  }

  const range = request.headers.get("range");
  const upstream = await fetch(blobUrl, { headers: range ? { range } : undefined, cache: "no-store" });

  const headers = new Headers();
  pickHeader(upstream.headers, headers, "content-type", { fallback: "application/pdf" });
  pickHeader(upstream.headers, headers, "content-length");
  pickHeader(upstream.headers, headers, "content-range");
  pickHeader(upstream.headers, headers, "accept-ranges");
  pickHeader(upstream.headers, headers, "etag");
  pickHeader(upstream.headers, headers, "last-modified");
  // Project links can be password protected; keep caching private.
  headers.set("cache-control", "private, max-age=3600");
  headers.set(
    "content-disposition",
    `${wantsDownload ? "attachment" : "inline"}; filename="${safePdfFilename(
      (doc.fileName as string | null | undefined) ?? (doc.title as string | null | undefined),
    )}"`,
  );

  return new Response(upstream.body, { status: upstream.status, headers });
}
