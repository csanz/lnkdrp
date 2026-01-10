import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFastWithPersonalOrg } from "@/lib/gating/actor";
import { decryptSharePassword, encryptSharePassword, hashSharePassword } from "@/lib/sharePassword";
import { ERROR_CODE_UNHANDLED_EXCEPTION, logErrorEvent } from "@/lib/errors/logger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
/**
 * Return whether object id.
 */


function isObjectId(id: string) {
  return Types.ObjectId.isValid(id);
}
/**
 * As Password.
 */


function asPassword(v: unknown): string | null {
  if (v === null) return null;
  if (typeof v !== "string") return null;
  return v;
}

function safeErrMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
}

function logSharePasswordError(args: {
  request: Request;
  method: "GET" | "POST";
  actor: { userId: string; orgId: string } | null;
  docId: string | null;
  err: unknown;
}) {
  // Always log to server console in dev so we can correlate "silent redirects".
  // eslint-disable-next-line no-console
  console.error("[api/docs/:docId/share-password] error", {
    method: args.method,
    docId: args.docId,
    actorUserId: args.actor?.userId ?? null,
    actorOrgId: args.actor?.orgId ?? null,
    message: safeErrMessage(args.err),
  });

  // Best-effort persist to Mongo ErrorEvent (when enabled by env policy).
  void logErrorEvent({
    severity: "error",
    category: "api",
    code: ERROR_CODE_UNHANDLED_EXCEPTION,
    err: args.err,
    request: args.request,
    route: "/api/docs/:docId/share-password",
    method: args.method,
    ids: {
      userId: args.actor?.userId ?? null,
      workspaceId: args.actor?.orgId ?? null,
      docId: args.docId ?? null,
    },
    meta: {
      handler: "share-password",
    },
  });
}
/**
 * Handle POST requests.
 */


export async function POST(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  let actor: Awaited<ReturnType<typeof resolveActor>> | null = null;
  let docIdForLog: string | null = null;
  try {
    actor = (await tryResolveUserActorFastWithPersonalOrg(request)) ?? (await resolveActor(request));
    const { docId } = await ctx.params;
    docIdForLog = docId;
    if (!isObjectId(docId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }

    const body = (await request.json().catch(() => ({}))) as unknown;
    const password = asPassword((body as { password?: unknown }).password);
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    const docMatch = allowLegacyByUserId
      ? {
          $or: [
            { _id: docObjectId, orgId },
            { _id: docObjectId, userId: legacyUserId, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
          ],
        }
      : { _id: docObjectId, orgId };
    if (password === null) {
      // Remove password.
      await connectMongo();
      const updated = await DocModel.findOneAndUpdate(
        { ...docMatch },
        { $set: { sharePasswordHash: null, sharePasswordSalt: null, sharePasswordEnc: null, sharePasswordEncIv: null, sharePasswordEncTag: null } },
        { new: true },
      ).lean();
      if (!updated) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }
      return applyTempUserHeaders(
        NextResponse.json(
          { sharePasswordEnabled: Boolean((updated as { sharePasswordHash?: unknown }).sharePasswordHash) },
          { headers: { "cache-control": "no-store" } },
        ),
        actor,
      );
    }

    const trimmed = password.trim();
    if (trimmed.length < 4) {
      return applyTempUserHeaders(
        NextResponse.json({ error: "Password must be at least 4 characters." }, { status: 400 }),
        actor,
      );
    }
    if (trimmed.length > 128) {
      return applyTempUserHeaders(
        NextResponse.json({ error: "Password is too long." }, { status: 400 }),
        actor,
      );
    }

    const { salt, hash } = hashSharePassword(trimmed);
    const enc = encryptSharePassword(trimmed);

    await connectMongo();
    const updated = await DocModel.findOneAndUpdate(
      { ...docMatch },
      {
        $set: {
          sharePasswordSalt: salt,
          sharePasswordHash: hash,
          sharePasswordEnc: enc.enc,
          sharePasswordEncIv: enc.iv,
          sharePasswordEncTag: enc.tag,
        },
      },
      { new: true },
    ).lean();
    if (!updated) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    return applyTempUserHeaders(
      NextResponse.json(
        { sharePasswordEnabled: Boolean((updated as { sharePasswordHash?: unknown }).sharePasswordHash) },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    logSharePasswordError({
      request,
      method: "POST",
      actor: actor ? { userId: actor.userId, orgId: actor.orgId } : null,
      docId: docIdForLog,
      err,
    });
    const message = safeErrMessage(err);
    if (actor) {
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
/**
 * Handle GET requests.
 */


export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
  const url = new URL(request.url);
  const lite = url.searchParams.get("lite") === "1";
  let actor: Awaited<ReturnType<typeof resolveActor>> | null = null;
  let docIdForLog: string | null = null;
  try {
    actor = (await tryResolveUserActorFastWithPersonalOrg(request)) ?? (await resolveActor(request));
    const { docId } = await ctx.params;
    docIdForLog = docId;
    if (!isObjectId(docId)) {
      return applyTempUserHeaders(NextResponse.json({ error: "Invalid docId" }, { status: 400 }), actor);
    }

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const doc = await DocModel.findOne({
      ...(allowLegacyByUserId
        ? {
            $or: [
              { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } },
              {
                _id: new Types.ObjectId(docId),
                userId: legacyUserId,
                isDeleted: { $ne: true },
                $or: [{ orgId: { $exists: false } }, { orgId: null }],
              },
            ],
          }
        : { _id: new Types.ObjectId(docId), orgId, isDeleted: { $ne: true } }),
    })
      .select(
        lite
          ? { sharePasswordHash: 1 }
          : { sharePasswordHash: 1, sharePasswordEnc: 1, sharePasswordEncIv: 1, sharePasswordEncTag: 1 },
      )
      .lean();

    if (!doc) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const enabled = Boolean((doc as { sharePasswordHash?: unknown }).sharePasswordHash);
    if (lite) {
      return applyTempUserHeaders(
        NextResponse.json(
          { sharePasswordEnabled: enabled, password: null },
          { headers: { "cache-control": "no-store" } },
        ),
        actor,
      );
    }
    const password = decryptSharePassword({
      enc: (doc as { sharePasswordEnc?: unknown }).sharePasswordEnc as string | null | undefined,
      iv: (doc as { sharePasswordEncIv?: unknown }).sharePasswordEncIv as string | null | undefined,
      tag: (doc as { sharePasswordEncTag?: unknown }).sharePasswordEncTag as string | null | undefined,
    });

    return applyTempUserHeaders(
      NextResponse.json(
        { sharePasswordEnabled: enabled, password: enabled ? password : null },
        { headers: { "cache-control": "no-store" } },
      ),
      actor,
    );
  } catch (err) {
    logSharePasswordError({
      request,
      method: "GET",
      actor: actor ? { userId: actor.userId, orgId: actor.orgId } : null,
      docId: docIdForLog,
      err,
    });
    const message = safeErrMessage(err);
    if (actor) {
      return applyTempUserHeaders(NextResponse.json({ error: message }, { status: 400 }), actor);
    }
    return NextResponse.json({ error: message }, { status: 400 });
  }
}






