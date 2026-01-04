import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { applyTempUserHeaders, resolveActor } from "@/lib/gating/actor";
import { PageTimingModel } from "@/lib/models/PageTiming";
import { ProjectClickModel } from "@/lib/models/ProjectClick";
import { ProjectViewModel } from "@/lib/models/ProjectView";
import { DocModel } from "@/lib/models/Doc";
import { DocPageTimingModel } from "@/lib/models/DocPageTiming";

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
  const actor = await resolveActor(request);
  try {
    const body = (await request.json().catch(() => ({}))) as unknown as Partial<MetricsEvent>;
    const type = asNonEmptyString(body?.type, 64);
    if (!type) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing type" }, { status: 400 }), actor);
    }

    if (!Types.ObjectId.isValid(actor.userId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid actor" }, { status: 400 }), actor);
    }
    const viewerUserId = new Types.ObjectId(actor.userId);

    const sessionIdRaw = asNonEmptyString((body as { sessionId?: unknown })?.sessionId, 256);
    if (!sessionIdRaw) {
      return applyTempUserHeaders(NextResponse.json({ error: "Missing sessionId" }, { status: 400 }), actor);
    }
    const sessionIdHash = hashSessionId(sessionIdRaw);

    await connectMongo();

    if (type === "page_timing") {
      const path = asNonEmptyString((body as { path?: unknown })?.path, 2048);
      const referrer = asNonEmptyString((body as { referrer?: unknown })?.referrer, 2048);
      const enteredAtMs = asFiniteNumber((body as { enteredAtMs?: unknown })?.enteredAtMs);
      const leftAtMs = asFiniteNumber((body as { leftAtMs?: unknown })?.leftAtMs);
      if (!path || enteredAtMs === null || leftAtMs === null) {
        return applyTempUserHeaders(NextResponse.json({ error: "Invalid page_timing payload" }, { status: 400 }), actor);
      }
      if (leftAtMs < enteredAtMs) {
        return applyTempUserHeaders(NextResponse.json({ error: "Invalid timing range" }, { status: 400 }), actor);
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
      return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
    }

    if (type === "doc_page_timing") {
      const docIdRaw = asNonEmptyString((body as { docId?: unknown })?.docId, 64);
      const version = asFiniteNumber((body as { version?: unknown })?.version);
      const pageNumber = asFiniteNumber((body as { pageNumber?: unknown })?.pageNumber);
      const enteredAtMs = asFiniteNumber((body as { enteredAtMs?: unknown })?.enteredAtMs);
      const leftAtMs = asFiniteNumber((body as { leftAtMs?: unknown })?.leftAtMs);
      if (!docIdRaw || !Types.ObjectId.isValid(docIdRaw)) {
        return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
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
        return applyTempUserHeaders(
          NextResponse.json({ error: "Invalid doc_page_timing payload" }, { status: 400 }),
          actor,
        );
      }
      if (leftAtMs < enteredAtMs) {
        return applyTempUserHeaders(NextResponse.json({ error: "Invalid timing range" }, { status: 400 }), actor);
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
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }

      const durationMs = Math.max(0, Math.min(24 * 60 * 60 * 1000, Math.round(leftAtMs - enteredAtMs)));
      await DocPageTimingModel.create({
        orgId,
        docId: docObjectId,
        version: Math.floor(version),
        viewerUserId,
        sessionIdHash,
        pageNumber: Math.floor(pageNumber),
        enteredAt: new Date(enteredAtMs),
        leftAt: new Date(leftAtMs),
        durationMs,
      });
      return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
    }

    if (type === "project_view") {
      const projectIdRaw = asNonEmptyString((body as { projectId?: unknown })?.projectId, 64);
      const path = asNonEmptyString((body as { path?: unknown })?.path, 2048) ?? "";
      if (!projectIdRaw || !Types.ObjectId.isValid(projectIdRaw)) {
        return applyTempUserHeaders(NextResponse.json({ error: "Invalid projectId" }, { status: 400 }), actor);
      }
      const projectId = new Types.ObjectId(projectIdRaw);

      // Dedupe: one view per session per user per project.
      await ProjectViewModel.updateOne(
        { projectId, viewerUserId, sessionIdHash },
        { $setOnInsert: { projectId, viewerUserId, sessionIdHash, path } },
        { upsert: true },
      );
      return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
    }

    if (type === "project_click") {
      const projectIdRaw = asNonEmptyString((body as { projectId?: unknown })?.projectId, 64);
      const fromPath = asNonEmptyString((body as { fromPath?: unknown })?.fromPath, 2048) ?? "";
      const toPath = asNonEmptyString((body as { toPath?: unknown })?.toPath, 2048);
      const toDocIdRaw = asNonEmptyString((body as { toDocId?: unknown })?.toDocId, 64);
      if (!projectIdRaw || !Types.ObjectId.isValid(projectIdRaw)) {
        return applyTempUserHeaders(NextResponse.json({ error: "Invalid projectId" }, { status: 400 }), actor);
      }
      if (!toPath) {
        return applyTempUserHeaders(NextResponse.json({ error: "Invalid toPath" }, { status: 400 }), actor);
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
      return applyTempUserHeaders(NextResponse.json({ ok: true }), actor);
    }

    return applyTempUserHeaders(NextResponse.json({ error: "Unknown type" }, { status: 400 }), actor);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
  }
}




