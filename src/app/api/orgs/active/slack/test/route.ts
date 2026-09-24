/**
 * `POST /api/orgs/active/slack/test` — post "LinkDrop is connected" through one channel.
 *
 * Owner/admin. The first message a customer sees is proof the wiring works, sent through the
 * same code path every event will use, so a channel that cannot receive it is caught here and
 * not on the first real open. The connection's state is updated exactly as a real post would.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { resolveActor } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { OrgModel } from "@/lib/models/Org";
import { SlackConnectionModel } from "@/lib/models/SlackConnection";
import { postThroughConnection } from "@/lib/slack/connections";
import { slackTestMessage } from "@/lib/slack/messages";
import { resolveConfiguredSiteUrl } from "@/lib/urls";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user") return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    if (!Types.ObjectId.isValid(actor.userId) || !Types.ObjectId.isValid(actor.orgId)) {
      return NextResponse.json({ error: "Invalid workspace" }, { status: 400 });
    }
    const keyForbidden = forbidApiKey(actor, "send a Slack test message");
    if (keyForbidden) return keyForbidden;
    const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
    if (!role.ok) return NextResponse.json({ error: "Only an owner or admin can send a test message." }, { status: 403 });

    const body = (await request.json().catch(() => null)) as { connectionId?: unknown } | null;
    const connectionId = typeof body?.connectionId === "string" && Types.ObjectId.isValid(body.connectionId) ? new Types.ObjectId(body.connectionId) : null;
    if (!connectionId) return NextResponse.json({ error: "connectionId is required" }, { status: 400 });

    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const [connection, org] = await Promise.all([
      SlackConnectionModel.findOne({ _id: connectionId, orgId }).lean(),
      OrgModel.findOne({ _id: orgId }).select({ name: 1 }).lean(),
    ]);
    if (!connection) return NextResponse.json({ error: "Not found" }, { status: 404 });

    const appUrl = resolveConfiguredSiteUrl()?.origin ?? "http://localhost:3001";
    const workspaceName = ((org as { name?: string } | null)?.name ?? "").trim() || "your workspace";
    const outcome = await postThroughConnection(connection, slackTestMessage({ workspaceName, channelName: connection.channelName, appUrl }));
    if (outcome.kind === "sent") return NextResponse.json({ ok: true });
    const status = outcome.kind === "revoked" ? 410 : 502;
    return NextResponse.json({ ok: false, outcome: outcome.kind, reason: outcome.reason }, { status });
  });
}
