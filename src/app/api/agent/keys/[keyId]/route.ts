/**
 * `DELETE /api/agent/keys/:keyId` — revoke one agent key (owner/admin only).
 *
 * Revocation is in place (`revokedAt` is set; the row stays listed as revoked). 204 on success,
 * 404 `{ error: "not_found" }` when the key is unknown to this workspace or already revoked.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActorForStats } from "@/lib/gating/actor";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { revokeApiKey } from "@/lib/agents/apiKeys";
import { recordActivity } from "@/lib/activity/log";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** Revoke an agent key. */
export async function DELETE(request: Request, ctx: { params: Promise<{ keyId: string }> }) {
  try {
    const { keyId } = await ctx.params;
    if (!Types.ObjectId.isValid(keyId)) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

    const actor = await resolveActorForStats(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400, headers: NO_STORE });

    const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
    if (!role.ok) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });

    const revoked = await revokeApiKey({ orgId: actor.orgId, keyId });
    if (!revoked) return NextResponse.json({ error: "not_found" }, { status: 404, headers: NO_STORE });

    void recordActivity({
      orgId: actor.orgId,
      userId: actor.userId,
      actorKind: "user",
      type: "agent.key_revoked",
      meta: { keyId: revoked.id, name: revoked.name, prefix: revoked.prefix },
      request,
    });

    return new NextResponse(null, { status: 204, headers: NO_STORE });
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not revoke agent key", context: "[api/agent/keys/:keyId] DELETE failed" });
  }
}
