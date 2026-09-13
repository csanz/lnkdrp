/**
 * `GET /api/agent/status` — whether an AI agent has connected to the active workspace.
 *
 * Session auth (any workspace member). Returns the `AgentStatus` shape consumed by
 * `useAgentStatus()`: `{ connected, lastUsedAt, lastUsedClient, activeKeys, keys, canManage }`,
 * where `canManage` is true for owners/admins. Temp users get 401 (keys are a signed-in feature).
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActorForStats } from "@/lib/gating/actor";
import { requireOrgRole, roleAtLeast } from "@/lib/orgs/requireOrgRole";
import { getAgentStatus } from "@/lib/agents/apiKeys";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** Agent connection status + key list for the active workspace. */
export async function GET(request: Request) {
  try {
    const actor = await resolveActorForStats(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400, headers: NO_STORE });

    const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "viewer" });
    if (!role.ok) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });

    const status = await getAgentStatus(actor.orgId);
    return NextResponse.json(
      { ...status, isPersonalOrg: actor.orgId === actor.personalOrgId, canManage: roleAtLeast(role.role, "admin") },
      { headers: NO_STORE },
    );
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not load agent status", context: "[api/agent/status] GET failed" });
  }
}
