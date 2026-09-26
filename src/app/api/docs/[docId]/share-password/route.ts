import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { DocModel } from "@/lib/models/Doc";
import { applyTempUserHeaders, resolveActor, tryResolveUserActorFastWithPersonalOrg } from "@/lib/gating/actor";
import { encryptSharePassword, hashSharePassword } from "@/lib/sharePassword";
import { ensureDefaultLink, updateShareLink } from "@/lib/share/links";
import { SHARE_PASSWORD_MAX, SHARE_PASSWORD_MIN } from "@/lib/share/passwordPolicy";
import { WITH_DOC_PASSWORD_HASH } from "@/lib/share/passwordSelect";
import { ERROR_CODE_UNHANDLED_EXCEPTION, logErrorEvent } from "@/lib/errors/logger";
import { debugError } from "@/lib/debug";
import { forbidUnlessOrgRole } from "@/lib/orgs/requireOrgEditor";
import { recordActivity } from "@/lib/activity/log";
import { buildDocMatch } from "@/lib/docs/docMatch";

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

/**
 * Set or clear the share password on the document's default link.
 *
 * Since docs/prds/lnkdrp-multi-links.md the password that gates `/s/:shareId` lives on the link,
 * not on the document; this route keeps its contract by writing through to the default link (the
 * one behind `Doc.shareId`). `updateShareLink` re-mirrors the material onto the document, so the
 * response — which reads the document — is unchanged.
 */
async function writePasswordToDefaultLink(
  doc: Record<string, unknown> & { _id: unknown },
  password: string | null,
): Promise<void> {
  const link = await ensureDefaultLink({
    _id: doc._id as Types.ObjectId,
    orgId: (doc.orgId ?? null) as Types.ObjectId | null,
    userId: (doc.userId ?? null) as Types.ObjectId | null,
    shareId: typeof doc.shareId === "string" ? doc.shareId : null,
    shareEnabled: doc.shareEnabled !== false,
  });
  await updateShareLink({ orgId: link.orgId, linkId: link._id, settings: { password } });
}

function logSharePasswordError(args: {
  request: Request;
  method: "GET" | "POST";
  actor: { userId: string; orgId: string } | null;
  docId: string | null;
  err: unknown;
}) {
  debugError(1, "[api/docs/:docId/share-password] error", {
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

    // Viewers can read a workspace but must not change share settings.
    const forbidden = await forbidUnlessOrgRole(actor);
    if (forbidden) return forbidden;

    const body = (await request.json().catch(() => ({}))) as unknown;
    const password = asPassword((body as { password?: unknown }).password);
    const orgId = new Types.ObjectId(actor.orgId);
    const legacyUserId = new Types.ObjectId(actor.userId);
    const allowLegacyByUserId = actor.orgId === actor.personalOrgId;
    const docObjectId = new Types.ObjectId(docId);
    // Was a hand-rolled copy of this filter that omitted `isDeleted` entirely, so a password could
    // be set on — or cleared from — a document already in the trash, and the write-through re-armed
    // its default link. `buildDocMatch` is the one rule; see src/lib/docs/docMatch.ts.
    const docMatch = buildDocMatch(docObjectId, orgId, legacyUserId, allowLegacyByUserId);
    if (password === null) {
      // Remove password.
      await connectMongo();
      const updated = await DocModel.findOneAndUpdate(
        { ...docMatch },
        { $set: { sharePasswordHash: null, sharePasswordSalt: null, sharePasswordEnc: null, sharePasswordEncIv: null, sharePasswordEncTag: null } },
        // The mirror is `select: false`; the response below reads its hash to report the state.
        { new: true, projection: WITH_DOC_PASSWORD_HASH },
      ).lean();
      if (!updated) {
        return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
      }
      await writePasswordToDefaultLink(updated as Record<string, unknown> & { _id: unknown }, null);
      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: actor.kind,
        type: "share.password_cleared",
        docId: docObjectId,
        title: (updated as { title?: unknown }).title as string | null | undefined,
        request,
      });
      return applyTempUserHeaders(
        NextResponse.json(
          { sharePasswordEnabled: Boolean((updated as { sharePasswordHash?: unknown }).sharePasswordHash) },
          { headers: { "cache-control": "no-store" } },
        ),
        actor,
      );
    }

    const trimmed = password.trim();
    if (trimmed.length < SHARE_PASSWORD_MIN) {
      return applyTempUserHeaders(NextResponse.json({ error: "Password cannot be blank." }, { status: 400 }), actor);
    }
    if (trimmed.length > SHARE_PASSWORD_MAX) {
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
      { new: true, projection: WITH_DOC_PASSWORD_HASH },
    ).lean();
    if (!updated) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }
    await writePasswordToDefaultLink(updated as Record<string, unknown> & { _id: unknown }, trimmed);

    void recordActivity({
      orgId: actor.orgId,
      userId: actor.userId,
      actorKind: actor.kind,
      type: "share.password_set",
      docId: docObjectId,
      title: (updated as { title?: unknown }).title as string | null | undefined,
      request,
    });

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
 * Say WHETHER the document's default link has a password. Never what it is.
 *
 * This used to decrypt `sharePasswordEnc` and hand back the plaintext to anyone with a membership
 * row, which is every role including `viewer` — the read-only seat handed to outside reviewers.
 * A viewer could walk the ids from `GET /api/docs` and collect the password for every protected
 * link in the workspace, and because nothing here wrote an activity row the collection left no
 * trace. Reading a secret back out is a higher permission than setting one, and this route had no
 * permission at all.
 *
 * The reveal is not gated here, it is gone: there is exactly one way to read a share password back
 * out, `GET /api/docs/:docId/links/:linkId/password`, which is admin-or-owner only, rate-limited,
 * refuses deleted links, and records `share_link.password_revealed`. Two reveal paths means one of
 * them is the unaudited one; a second implementation of a rule is how the rule drifts.
 *
 * Nothing asked for the plaintext: no UI code, no MCP tool (`mcp/src/api.ts` only POSTs here), and
 * `scripts/tests-benchmark.ts` calls this with `?lite=1`, which never returned it. `password` is
 * kept in the body as a permanent `null` so an old caller reads "no password available" rather
 * than crashing on a missing field.
 */
export async function GET(request: Request, ctx: { params: Promise<{ docId: string }> }) {
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
    const doc = await DocModel.findOne(
      buildDocMatch(new Types.ObjectId(docId), orgId, legacyUserId, allowLegacyByUserId),
    )
      // The encrypted material is not selected, so this handler cannot leak it however it changes.
      .select({ sharePasswordHash: 1 })
      .lean();

    if (!doc) {
      return applyTempUserHeaders(NextResponse.json({ error: "Not found" }, { status: 404 }), actor);
    }

    const enabled = Boolean((doc as { sharePasswordHash?: unknown }).sharePasswordHash);
    return applyTempUserHeaders(
      NextResponse.json(
        { sharePasswordEnabled: enabled, password: null },
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






