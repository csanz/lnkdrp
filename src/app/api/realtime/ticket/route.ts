/**
 * `GET /api/realtime/ticket` — mint a 60s ticket the browser hands to the WebSocket server.
 *
 * Session auth (any member of the active workspace). Returns `{ url, ticket, expiresAt }` where
 * `url` is `NEXT_PUBLIC_REALTIME_URL` (empty when realtime is not configured, in which case the
 * client stays on polling). The ticket is bound to the user and the active workspace, so a
 * workspace switch needs a new ticket; the client reconnects on `ACTIVE_ORG_CHANGED_EVENT`.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActorForStats } from "@/lib/gating/actor";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { signRealtimeTicket } from "@/lib/realtime/ticket";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

export async function GET(request: Request) {
  try {
    /**
     * A runtime way to turn realtime off, because the URL alone is not one.
     *
     * `NEXT_PUBLIC_REALTIME_URL` is inlined at build time, so the documented rollback - unset it -
     * needs a full redeploy. Until that lands, every open tab keeps retrying a dead server and
     * waking this route, which is dynamic and reads Mongo twice, every thirty seconds per tab.
     * `REALTIME_DISABLED` is read here, at request time, and answers the same empty payload the
     * clients already treat as "poll instead".
     */
    const disabled = ["1", "true"].includes((process.env.REALTIME_DISABLED ?? "").trim().toLowerCase());
    const url = disabled ? "" : (process.env.NEXT_PUBLIC_REALTIME_URL || "").trim();
    const actor = await resolveActorForStats(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });
    if (!Types.ObjectId.isValid(actor.orgId)) return NextResponse.json({ error: "Invalid org" }, { status: 400, headers: NO_STORE });

    const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "viewer" });
    if (!role.ok) return NextResponse.json({ error: "forbidden" }, { status: 403, headers: NO_STORE });

    if (!url) return NextResponse.json({ url: "", ticket: null, expiresAt: null }, { headers: NO_STORE });
    const { ticket, expiresAt } = signRealtimeTicket({ userId: actor.userId, orgId: actor.orgId });
    return NextResponse.json({ url, ticket, expiresAt }, { headers: NO_STORE });
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not issue a realtime ticket", context: "[api/realtime/ticket] GET failed" });
  }
}
