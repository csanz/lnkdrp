/**
 * API route for `/api/requests/:token/uploads`.
 *
 * Starts an upload for a request link (creates doc + upload) and returns an upload secret.
 */
import { NextResponse } from "next/server";
import crypto from "node:crypto";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { ProjectModel } from "@/lib/models/Project";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import { debugError, debugLog } from "@/lib/debug";
import { BOT_ID_HEADER } from "@/lib/botId";
import { ensurePersonalOrgForUserId } from "@/lib/models/Org";
import { tryResolveUserActor } from "@/lib/gating/actor";
import { randomBase62, newShareId, newSecretToken } from "@/lib/crypto/randomBase62";

export const runtime = "nodejs";

/**
 * Generate a short public identifier for `/s/:shareId`.
 *
 * This is a public slug (not a secret).
 */
function newDocShareId() {
  return newShareId();
}

/**
 * Generate a secret token for a public "replace upload" link for a doc.
 *
 * This is a capability token (treat as secret) and should be long enough to be unguessable.
 */
function newReplaceUploadToken() {
  return newSecretToken(24);
}
/**
 * New Upload Secret (uses toString, randomBytes).
 */


function newUploadSecret() {
  // Capability secret for this upload (used by recipient to PATCH/process without auth).
  return crypto.randomBytes(24).toString("base64url");
}

type MongoDupKeyError = {
  code?: unknown;
  keyPattern?: Record<string, unknown>;
  keyValue?: Record<string, unknown>;
  message?: unknown;
};

function getDupKeyFields(err: unknown): string[] {
  if (!err || typeof err !== "object") return [];
  const e = err as MongoDupKeyError;
  if (e.code !== 11000) return [];
  const fields = new Set<string>();
  for (const src of [e.keyPattern, e.keyValue]) {
    if (!src || typeof src !== "object") continue;
    for (const k of Object.keys(src)) fields.add(k);
  }
  const msg = typeof e.message === "string" ? e.message : "";
  const m = msg.match(/dup key.*?\{(.*?)\}/i);
  if (m?.[1]) {
    const keys = m[1]
      .split(",")
      .map((s) => s.split(":")[0]?.trim())
      .filter(Boolean);
    for (const k of keys) fields.add(k);
  }
  return Array.from(fields);
}

function describeMongoError(err: unknown): Record<string, unknown> {
  if (!err || typeof err !== "object") return {};
  const e = err as MongoDupKeyError & { name?: unknown };
  return {
    name: typeof e.name === "string" ? e.name : undefined,
    code: typeof e.code === "number" ? e.code : undefined,
    dupKeyFields: getDupKeyFields(err),
    keyPattern: e.keyPattern ?? undefined,
    keyValue: e.keyValue ?? undefined,
  };
}
/**
 * Title From File Name (uses trim, pop, split).
 */


function titleFromFileName(name: string) {
  const raw = (name || "").trim();
  if (!raw) return "Untitled document";
  const base = raw.split(/[\\/]/).pop() ?? raw;
  const withoutExt = base.replace(/\.[a-z0-9]{1,6}$/i, "");
  const t = withoutExt.trim();
  return t || "Untitled document";
}

/**
 * Start an upload for a request link:
 * - creates a Doc inside the request owner's account
 * - associates it with the request folder (Project)
 * - creates an Upload record and returns an `uploadSecret` for follow-up calls
 */
export async function POST(
  request: Request,
  ctx: { params: Promise<{ token: string }> },
) {
  try {
    const { token } = await ctx.params;
    const requestToken = decodeURIComponent(token || "").trim();
    if (!requestToken) return NextResponse.json({ error: "Invalid token" }, { status: 400 });

    const body = (await request.json().catch(() => ({}))) as Partial<{
      originalFileName: string;
      contentType: string;
      sizeBytes: number;
    }>;
    const originalFileName =
      typeof body.originalFileName === "string" ? body.originalFileName.trim() : "";
    const contentType = typeof body.contentType === "string" ? body.contentType.trim() : "";
    const sizeBytes = Number.isFinite(body.sizeBytes) ? Number(body.sizeBytes) : null;

    if (!originalFileName) {
      return NextResponse.json({ error: "Missing originalFileName" }, { status: 400 });
    }

    debugLog(1, "[api/requests/:token/uploads] POST", { token: "[redacted]" });
    await connectMongo();

    const project = await ProjectModel.findOne({ requestUploadToken: requestToken })
      .select({ _id: 1, orgId: 1, userId: 1, name: 1, description: 1, isRequest: 1, requestRequireAuthToUpload: 1 })
      .lean();

    if (!project || !project._id || !(project as { userId?: unknown }).userId) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    const requireAuthToUpload = Boolean(
      (project as unknown as { requestRequireAuthToUpload?: unknown }).requestRequireAuthToUpload,
    );
    if (requireAuthToUpload) {
      const actor = await tryResolveUserActor(request);
      if (!actor) {
        return NextResponse.json({ error: "AUTH_REQUIRED" }, { status: 401 });
      }
    } else {
      const botId =
        request.headers.get(BOT_ID_HEADER) ?? request.headers.get(BOT_ID_HEADER.toLowerCase()) ?? "";
      if (!botId || botId.trim().length < 8 || botId.trim().length > 128) {
        // Public request links are intentionally no-sign-in; require a lightweight bot/device id instead.
        return NextResponse.json({ error: "BOT_ID_REQUIRED" }, { status: 403 });
      }
    }

    // Best-effort backfill: older rows may have `requestUploadToken` but missing/false `isRequest`.
    // (Mongoose schema hooks do not run for raw update operations.)
    try {
      const persistedIsRequest = Boolean((project as unknown as { isRequest?: unknown }).isRequest);
      if (!persistedIsRequest) {
        await ProjectModel.updateOne(
          { _id: project._id, requestUploadToken: requestToken },
          { $set: { isRequest: true } },
        );
      }
    } catch {
      // ignore; request token itself is the capability, so allowing the link is still correct
    }

    const ownerUserId = new Types.ObjectId(String((project as { userId: unknown }).userId));
    const projectId = new Types.ObjectId(String(project._id));
    const projectOrgIdRaw = (project as unknown as { orgId?: unknown }).orgId;
    const effectiveOrgId =
      projectOrgIdRaw && Types.ObjectId.isValid(String(projectOrgIdRaw))
        ? new Types.ObjectId(String(projectOrgIdRaw))
        : (await ensurePersonalOrgForUserId({ userId: ownerUserId })).orgId;

    // Best-effort: if the request project is missing orgId (legacy), backfill it.
    if (!projectOrgIdRaw) {
      try {
        await ProjectModel.updateOne({ _id: projectId, requestUploadToken: requestToken }, { $set: { orgId: effectiveOrgId } });
      } catch {
        // ignore
      }
    }

    // Create with a shareId (retry on rare collisions).
    let docId: Types.ObjectId | null = null;
    let lastErr: unknown = null;
    let title = titleFromFileName(originalFileName);
    for (let i = 0; i < 3; i++) {
      try {
        const created = await DocModel.create({
          orgId: effectiveOrgId,
          userId: ownerUserId,
          title,
          status: "draft",
          shareId: newDocShareId(),
          projectId,
          projectIds: [projectId],
          receivedViaRequestProjectId: projectId,
          replaceUploadToken: newReplaceUploadToken(),
        });
        const doc = (Array.isArray(created) ? created[0] : created) as typeof created;
        docId = (doc as unknown as { _id?: Types.ObjectId })._id ?? null;
        break;
      } catch (e) {
        lastErr = e;
        const dupFields = getDupKeyFields(e);
        if (dupFields.includes("shareId")) continue;
        if (dupFields.includes("title")) {
          title = `${title} (${randomBase62(4)})`;
          continue;
        }
        throw e;
      }
    }
    if (!docId) {
      const details = describeMongoError(lastErr);
      throw new Error(
        `Failed to create doc${
          details.dupKeyFields ? ` (dupKeyFields=${JSON.stringify(details.dupKeyFields)})` : ""
        }`,
      );
    }

    const uploadSecret = newUploadSecret();
    const upload = await UploadModel.create({
      orgId: effectiveOrgId,
      userId: ownerUserId,
      docId,
      version: 1,
      status: "uploading",
      originalFileName,
      contentType: contentType || null,
      sizeBytes,
      metadata: {
        size: sizeBytes ?? undefined,
      },
      uploadSecret,
    });

    const uploadId = (upload as unknown as { _id?: Types.ObjectId })._id ?? null;
    if (!uploadId) throw new Error("Failed to create upload");

    await DocModel.findByIdAndUpdate(docId, {
      status: "preparing",
      currentUploadId: uploadId,
      uploadId, // backward compat
    });

    return NextResponse.json(
      {
        request: {
          projectId: String(projectId),
          name: typeof project.name === "string" ? project.name : "",
          description: typeof project.description === "string" ? project.description : "",
        },
        doc: { id: String(docId) },
        upload: { id: String(uploadId), secret: uploadSecret },
      },
      { status: 201 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    debugError(1, "[api/requests/:token/uploads] POST failed", {
      message,
      ...(describeMongoError(err) as Record<string, unknown>),
    });
    return NextResponse.json({ error: message }, { status: 400 });
  }
}


