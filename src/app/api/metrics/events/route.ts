import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { resolveExistingActor } from "@/lib/gating/actor";
import { errorJson } from "@/lib/http/errorResponse";
import { PageTimingModel } from "@/lib/models/PageTiming";
import { ProjectClickModel } from "@/lib/models/ProjectClick";
import { ProjectViewModel } from "@/lib/models/ProjectView";
import { DocModel } from "@/lib/models/Doc";
import { DocPageTimingModel } from "@/lib/models/DocPageTiming";
import { ShareLinkModel } from "@/lib/models/ShareLink";

export const runtime = "nodejs";
/**
 * As Non Empty String (uses trim).
 */


function asNonEmptyString(v: unknown, maxLen = 1024): string | null {
  if (typeof v !== "string") return null;
  const s = v.trim();
  if (!s) return null;
  if (s.length > maxLen) return null;
  return s;
}
/**
 * As Finite Number (uses Number, isFinite).
 */


function asFiniteNumber(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return null;
  return n;
}
/**
 * Hash Session Id (uses digest, update, createHash).
 */


function hashSessionId(raw: string): string {
  return crypto.createHash("sha256").update(raw).digest("hex");
}

type MetricsEvent =
  | {
      type: "page_timing";
      sessionId: string;
      path: string;
      referrer?: string | null;
      enteredAtMs: number;
      leftAtMs: number;
    }
  | {
      type: "doc_page_timing";
      sessionId: string;
      docId: string;
      version: number;
      pageNumber: number;
      enteredAtMs: number;
      leftAtMs: number;
      /** The share link the page was read through, when it was read through one. */
      shareId?: string | null;
    }
  | {
      type: "project_view";
      sessionId: string;
      projectId: string;
      path?: string;
    }
  | {
      type: "project_click";
      sessionId: string;
      projectId: string;
      fromPath?: string;
      toPath: string;
      toDocId?: string | null;
    };
/**
 * Handle POST requests.
 */


export async function POST(request: Request) {
  try {
    const body = (await request.json().catch(() => ({}))) as unknown as Partial<MetricsEvent>;
    const type = asNonEmptyString(body?.type, 64);
    if (!type) {
      return NextResponse.json({ error: "Missing type" }, { status: 400 });
    }

    // Never mint identities from a fire-and-forget analytics call: only a signed-in user or an
    // already-existing temp user (via headers) is attributed. Every event model requires a
    // `viewerUserId`, so events from unknown visitors are accepted and dropped.
    const actor = await resolveExistingActor(request);
    if (!actor || !Types.ObjectId.isValid(actor.userId)) {
      return NextResponse.json({ ok: true, ignored: true });
    }
    const viewerUserId = new Types.ObjectId(actor.userId);

    const sessionIdRaw = asNonEmptyString((body as { sessionId?: unknown })?.sessionId, 256);
    if (!sessionIdRaw) {
      return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
    }
    const sessionIdHash = hashSessionId(sessionIdRaw);

    await connectMongo();

    if (type === "page_timing") {
      const path = asNonEmptyString((body as { path?: unknown })?.path, 2048);
      const referrer = asNonEmptyString((body as { referrer?: unknown })?.referrer, 2048);
      const enteredAtMs = asFiniteNumber((body as { enteredAtMs?: unknown })?.enteredAtMs);
      const leftAtMs = asFiniteNumber((body as { leftAtMs?: unknown })?.leftAtMs);
      if (!path || enteredAtMs === null || leftAtMs === null) {
        return NextResponse.json({ error: "Invalid page_timing payload" }, { status: 400 });
      }
      if (leftAtMs < enteredAtMs) {
        return NextResponse.json({ error: "Invalid timing range" }, { status: 400 });
      }
      const durationMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(leftAtMs - enteredAtMs)));
      await PageTimingModel.create({
        viewerUserId,
        sessionIdHash,
        path,
        referrer: referrer ?? null,
        enteredAt: new Date(enteredAtMs),
        leftAt: new Date(leftAtMs),
        durationMs,
      });
      return NextResponse.json({ ok: true });
    }

    if (type === "doc_page_timing") {
      const docIdRaw = asNonEmptyString((body as { docId?: unknown })?.docId, 64);
      const version = asFiniteNumber((body as { version?: unknown })?.version);
      const pageNumber = asFiniteNumber((body as { pageNumber?: unknown })?.pageNumber);
      const enteredAtMs = asFiniteNumber((body as { enteredAtMs?: unknown })?.enteredAtMs);
      const leftAtMs = asFiniteNumber((body as { leftAtMs?: unknown })?.leftAtMs);
      if (!docIdRaw || !Types.ObjectId.isValid(docIdRaw)) {
        return NextResponse.json({ error: "Invalid docId" }, { status: 400 });
      }
      if (
        version === null ||
        !Number.isFinite(version) ||
        Math.floor(version) < 1 ||
        pageNumber === null ||
        !Number.isFinite(pageNumber) ||
        Math.floor(pageNumber) < 1 ||
        enteredAtMs === null ||
        leftAtMs === null
      ) {
        return NextResponse.json({ error: "Invalid doc_page_timing payload" }, { status: 400 });
      }
      if (leftAtMs < enteredAtMs) {
        return NextResponse.json({ error: "Invalid timing range" }, { status: 400 });
      }

      // Ensure the doc is visible in the actor's active org (with legacy personal-org fallback).
      const orgId = new Types.ObjectId(actor.orgId);
      const legacyUserId = new Types.ObjectId(actor.userId);
      const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
      const docObjectId = new Types.ObjectId(docIdRaw);
      const ok = await DocModel.exists({
        ...(allowLegacyByUserId
          ? {
              $or: [
                { _id: docObjectId, orgId, isDeleted: { $ne: true } },
                {
                  _id: docObjectId,
                  userId: legacyUserId,
                  isDeleted: { $ne: true },
                  $or: [{ orgId: { $exists: false } }, { orgId: null }],
                },
              ],
            }
          : { _id: docObjectId, orgId, isDeleted: { $ne: true } }),
      });
      if (!ok) {
        // Mirror other doc APIs: 404 for "not found / not authorized".
        return NextResponse.json({ error: "Not found" }, { status: 404 });
      }

      // Which link the reader came through, when they came through one. Only a link that belongs
      // to this document counts — a slug from anywhere else is dropped rather than trusted, so the
      // per-link scope cannot be spoofed by the payload.
      //
      // The `docId` is part of the QUERY, not a check applied to whatever came back. This used to
      // call `resolveShareLink(shareIdRaw)` on the raw body string and compare afterwards, and
      // `resolveShareLink` is a write: for a legacy slug with no link row it falls back to
      // `Doc.findOne({ shareId })` and then `ensureDefaultLink`, which creates a `ShareLink` and
      // `$set`s `Doc.shareId` — on a document in someone else's workspace. Any authenticated user
      // could trigger that by posting a foreign slug with their own `docId`, and the result was
      // then discarded, so nothing surfaced the write. One indexed lookup, no side effects, and no
      // link materialisation on a fire-and-forget ingest path.
      const shareIdRaw = asNonEmptyString((body as { shareId?: unknown })?.shareId, 64);
      const ownLink = shareIdRaw
        ? await ShareLinkModel.findOne({ shareId: shareIdRaw, docId: docObjectId }).select({ _id: 1 }).lean<{ _id: Types.ObjectId }>()
        : null;
      const shareLinkId = ownLink ? ownLink._id : null;

      const durationMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(leftAtMs - enteredAtMs)));
      await DocPageTimingModel.create({
        orgId,
        docId: docObjectId,
        version: Math.floor(version),
        shareId: shareLinkId ? shareIdRaw : null,
        shareLinkId,
        viewerUserId,
        sessionIdHash,
        pageNumber: Math.floor(pageNumber),
        enteredAt: new Date(enteredAtMs),
        leftAt: new Date(leftAtMs),
        durationMs,
      });
      return NextResponse.json({ ok: true });
    }

    if (type === "project_view") {
      const projectIdRaw = asNonEmptyString((body as { projectId?: unknown })?.projectId, 64);
      const path = asNonEmptyString((body as { path?: unknown })?.path, 2048) ?? "";
      if (!projectIdRaw || !Types.ObjectId.isValid(projectIdRaw)) {
        return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
      }
      const projectId = new Types.ObjectId(projectIdRaw);

      // Dedupe: one view per session per user per project.
      await ProjectViewModel.updateOne(
        { projectId, viewerUserId, sessionIdHash },
        { $setOnInsert: { projectId, viewerUserId, sessionIdHash, path } },
        { upsert: true },
      );
      return NextResponse.json({ ok: true });
    }

    if (type === "project_click") {
      const projectIdRaw = asNonEmptyString((body as { projectId?: unknown })?.projectId, 64);
      const fromPath = asNonEmptyString((body as { fromPath?: unknown })?.fromPath, 2048) ?? "";
      const toPath = asNonEmptyString((body as { toPath?: unknown })?.toPath, 2048);
      const toDocIdRaw = asNonEmptyString((body as { toDocId?: unknown })?.toDocId, 64);
      if (!projectIdRaw || !Types.ObjectId.isValid(projectIdRaw)) {
        return NextResponse.json({ error: "Invalid projectId" }, { status: 400 });
      }
      if (!toPath) {
        return NextResponse.json({ error: "Invalid toPath" }, { status: 400 });
      }
      const projectId = new Types.ObjectId(projectIdRaw);
      const toDocId = toDocIdRaw && Types.ObjectId.isValid(toDocIdRaw) ? new Types.ObjectId(toDocIdRaw) : null;

      await ProjectClickModel.create({
        projectId,
        viewerUserId,
        sessionIdHash,
        fromPath,
        toPath,
        ...(toDocId ? { toDocId } : {}),
      });
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown type" }, { status: 400 });
  } catch (err) {
    return errorJson(err, { status: 400, publicMessage: "Could not record event", context: "[api/metrics/events] POST failed" });
  }
}




