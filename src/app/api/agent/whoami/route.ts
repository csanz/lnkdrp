/**
 * `GET /api/agent/whoami` — verification endpoint for agent API keys.
 *
 * Bearer `lnk_` auth ONLY (via `verifyBearer`); there is deliberately no session or temp-user
 * fallback so a client can prove its key works from outside a browser. Clients self-identify with
 * `x-lnkdrp-agent: <client>/<version>`.
 *
 * 200 `{ ok: true, userId, email, orgId, orgName, isPersonalOrg, plan, keyPrefix, scopes, client, credentialId, credentialKind, integrations.slack }`
 * 401 `{ error: "unauthorized" | "key_revoked" }`
 *
 * The first ever use of a key records an `agent.connected` activity row attributed to the agent.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { verifyBearer, clientLabelFromRequest } from "@/lib/gating/apiKeyActor";
import { isToolClient } from "@/lib/agents/apiKeys";
import { UserModel } from "@/lib/models/User";
import { OrgModel } from "@/lib/models/Org";
import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { recordActivity } from "@/lib/activity/log";
import { listSlackConnections, serializeSlackConnection } from "@/lib/slack/connections";
import { errorJson } from "@/lib/http/errorResponse";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const NO_STORE = { "cache-control": "no-store" } as const;

/** Who does this API key act as, and for which workspace. */
export async function GET(request: Request) {
  try {
    const verified = await verifyBearer(request);
    if (!verified.ok) return NextResponse.json({ error: verified.code }, { status: 401, headers: NO_STORE });
    const { actor, key } = verified;

    await connectMongo();
    const [user, org, plan] = await Promise.all([
      UserModel.findOne({ _id: new Types.ObjectId(actor.userId) }).select({ email: 1 }).lean(),
      OrgModel.findOne({ _id: new Types.ObjectId(actor.orgId), isDeleted: { $ne: true } }).select({ name: 1, type: 1 }).lean(),
      getWorkspacePlan(actor.orgId),
    ]);
    if (!org) return NextResponse.json({ error: "unauthorized" }, { status: 401, headers: NO_STORE });

    const client = clientLabelFromRequest(request);

    // curl & co. verify the key (Verify step); a real client connecting is the bigger event.
    // Each is recorded once per key: the first tool use, and the first agent use.
    const tool = isToolClient(client);
    if (key.useCount === 0 || (!tool && isToolClient(key.lastUsedClient))) {
      void recordActivity({
        orgId: actor.orgId,
        userId: actor.userId,
        actorKind: "api_key",
        type: tool ? "agent.key_verified" : "agent.connected",
        meta: { keyId: key.id, name: key.name, prefix: key.prefix, client, ...(key.kind === "oauth" ? { via: "oauth" } : {}) },
        request,
      });
    }

    // What the workspace posts to Slack (docs/prds/lnkdrp-slack.md, M4): channel names, the
    // default, the projects routed to each, the four switches. Never the webhook. Best-effort:
    // whoami must not fail because this read did.
    const slackChannels = await listSlackConnections(new Types.ObjectId(actor.orgId))
      .then((rows) =>
        rows.map(serializeSlackConnection).map((c) => ({
          channelName: c.channelName,
          teamName: c.teamName,
          isDefault: c.isDefault,
          status: c.status,
          projectIds: c.projectIds,
          events: c.events,
          lastPostAt: c.lastPostAt,
        })),
      )
      .catch(() => []);

    return NextResponse.json(
      {
        ok: true,
        userId: actor.userId,
        email: typeof user?.email === "string" ? user.email : null,
        orgId: actor.orgId,
        orgName: typeof org.name === "string" ? org.name : null,
        isPersonalOrg: org.type === "personal",
        plan,
        keyPrefix: key.prefix,
        scopes: key.scopes,
        client,
        // The credential's identity, stable across OAuth token refreshes. The MCP server binds a
        // session to this rather than to the bearer, which for a grant changes every hour.
        credentialId: key.id,
        credentialKind: key.kind,
        integrations: { slack: { connected: slackChannels.some((c) => c.status === "active"), channels: slackChannels } },
      },
      { headers: NO_STORE },
    );
  } catch (err) {
    return errorJson(err, { status: 500, publicMessage: "Could not verify key", context: "[api/agent/whoami] GET failed" });
  }
}
