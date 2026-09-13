/**
 * `/api/agent/keys` — list and mint workspace API keys for AI agents.
 *
 * - GET: any member; `{ keys: AgentKeyRow[] }` (newest first, revoked included).
 * - POST: owner/admin only; body `{ name: string, scopes?: ("read"|"write")[] }`.
 *   201 `{ key: AgentKeyRow, plaintext }` — the plaintext is shown once and never stored.
 *   400 `{ error: "invalid_name" | "invalid_scopes" | "invalid_body" }`, 403 `{ error: "forbidden" }`,
 *   409 `{ error: "key_limit" }` when the workspace already has 10 active keys.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActorForStats } from "@/lib/gating/actor";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import {
  API_KEY_MAX_ACTIVE_PER_ORG,
  API_KEY_NAME_MAX_LENGTH,
  countActiveApiKeys,
  createApiKey,
  listApiKeys,
  normalizeScopes,
} from "@/lib/agents/apiKeys";
import { recordActivity } from "@/lib/activity/log";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** List the active workspace's agent keys. */
export async function GET(request: Request) {
  try {
    const actor = await resolveActorForStats(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400, headers: NO_STORE });

    const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "viewer" });
    if (!role.ok) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });

    const keys = await listApiKeys(actor.orgId);
    return NextResponse.json({ keys }, { headers: NO_STORE });
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not load agent keys", context: "[api/agent/keys] GET failed" });
  }
}

/** Mint a new agent key (owner/admin). The plaintext is returned exactly once. */
export async function POST(request: Request) {
  try {
    const actor = await resolveActorForStats(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400, headers: NO_STORE });

    const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
    if (!role.ok) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: "invalid_body" }, { status: 400, headers: NO_STORE });
    }
    const b = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
    const name = typeof b.name === "string" ? b.name.trim() : "";
    if (!name || name.length > API_KEY_NAME_MAX_LENGTH) {
      return NextResponse.json({ error: "invalid_name" }, { status: 400, headers: NO_STORE });
    }
    const scopes = normalizeScopes(b.scopes);
    if (scopes === null) return NextResponse.json({ error: "invalid_scopes" }, { status: 400, headers: NO_STORE });

    const active = await countActiveApiKeys(actor.orgId);
    if (active >= API_KEY_MAX_ACTIVE_PER_ORG) {
      return NextResponse.json({ error: "key_limit" }, { status: 409, headers: NO_STORE });
    }

    const { plaintext, key } = await createApiKey({ orgId: actor.orgId, userId: actor.userId, name, scopes });

    void recordActivity({
      orgId: actor.orgId,
      userId: actor.userId,
      actorKind: "user",
      type: "agent.key_created",
      meta: { keyId: key.id, name: key.name, prefix: key.prefix, scopes: key.scopes },
      request,
    });

    return NextResponse.json({ key, plaintext }, { status: 201, headers: NO_STORE });
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not create agent key", context: "[api/agent/keys] POST failed" });
  }
}
