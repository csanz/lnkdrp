/**
 * `/api/orgs/active/slack` — the active workspace's Slack channels.
 *
 * - `GET` (any member): `{ enabled, connections: SlackConnectionDto[] }`. Never the webhook URL.
 * - `PATCH` (owner/admin): `{ connectionId, events?: {…}, isDefault?: true, projectIds?: [] }`.
 *   Making one connection the default clears the flag on the others.
 * - `DELETE` (owner/admin): `{ connectionId }` removes the row and tells Slack to revoke the
 *   webhook's token when it can. If the default was removed, the oldest remaining channel
 *   becomes the default so events still have somewhere to go.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { recordActivity } from "@/lib/activity/log";
import { resolveActor } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { SlackConnectionModel } from "@/lib/models/SlackConnection";
import { slackEnabled } from "@/lib/slack/config";
import { SLACK_EVENT_KEYS, listSlackConnections, serializeSlackConnection, type SlackEventKey } from "@/lib/slack/connections";
import { withMongoRequestLogging } from "@/lib/db/mongoRequestLogger";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

async function adminContext(request: Request, verb: string) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return { error: NextResponse.json({ error: "Unauthorized" }, { status: 401 }) };
  if (!Types.ObjectId.isValid(actor.userId) || !Types.ObjectId.isValid(actor.orgId)) {
    return { error: NextResponse.json({ error: "Invalid workspace" }, { status: 400 }) };
  }
  const keyForbidden = forbidApiKey(actor, verb);
  if (keyForbidden) return { error: keyForbidden };
  const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
  if (!role.ok) return { error: NextResponse.json({ error: `Only an owner or admin can ${verb}.` }, { status: 403 }) };
  return { orgId: new Types.ObjectId(actor.orgId), userId: new Types.ObjectId(actor.userId) };
}

export async function GET(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const actor = await resolveActor(request);
    if (actor.kind !== "user" || !Types.ObjectId.isValid(actor.orgId) || !Types.ObjectId.isValid(actor.userId)) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
    }
    await connectMongo();
    const orgId = new Types.ObjectId(actor.orgId);
    const member = await OrgMembershipModel.exists({ orgId, userId: new Types.ObjectId(actor.userId), isDeleted: { $ne: true } });
    if (!member) return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    const rows = await listSlackConnections(orgId);
    return NextResponse.json({ enabled: slackEnabled(), connections: rows.map(serializeSlackConnection) }, { headers: { "cache-control": "no-store" } });
  });
}

export async function PATCH(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const ctx = await adminContext(request, "change Slack settings");
    if ("error" in ctx) return ctx.error;
    const body = (await request.json().catch(() => null)) as
      | { connectionId?: unknown; events?: Partial<Record<SlackEventKey, unknown>>; isDefault?: unknown; projectIds?: unknown }
      | null;
    const connectionId = typeof body?.connectionId === "string" && Types.ObjectId.isValid(body.connectionId) ? new Types.ObjectId(body.connectionId) : null;
    if (!connectionId) return NextResponse.json({ error: "connectionId is required" }, { status: 400 });

    const set: Record<string, unknown> = {};
    if (body?.events && typeof body.events === "object") {
      for (const key of SLACK_EVENT_KEYS) {
        if (typeof body.events[key] === "boolean") set[`events.${key}`] = body.events[key];
      }
    }
    if (Array.isArray(body?.projectIds)) {
      const ids = body.projectIds.filter((p): p is string => typeof p === "string" && Types.ObjectId.isValid(p));
      set.projectIds = ids.map((p) => new Types.ObjectId(p));
    }

    await connectMongo();
    const row = await SlackConnectionModel.findOne({ _id: connectionId, orgId: ctx.orgId }).select({ _id: 1 }).lean();
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });

    if (body?.isDefault === true) {
      await SlackConnectionModel.updateMany({ orgId: ctx.orgId, _id: { $ne: connectionId } }, { $set: { isDefault: false } });
      set.isDefault = true;
    }
    if (Object.keys(set).length) await SlackConnectionModel.updateOne({ _id: connectionId }, { $set: set });

    const rows = await listSlackConnections(ctx.orgId);
    return NextResponse.json({ ok: true, connections: rows.map(serializeSlackConnection) });
  });
}

export async function DELETE(request: Request) {
  return withMongoRequestLogging(request, async () => {
    const ctx = await adminContext(request, "disconnect Slack");
    if ("error" in ctx) return ctx.error;
    const body = (await request.json().catch(() => null)) as { connectionId?: unknown } | null;
    const connectionId = typeof body?.connectionId === "string" && Types.ObjectId.isValid(body.connectionId) ? new Types.ObjectId(body.connectionId) : null;
    if (!connectionId) return NextResponse.json({ error: "connectionId is required" }, { status: 400 });

    await connectMongo();
    const row = await SlackConnectionModel.findOne({ _id: connectionId, orgId: ctx.orgId }).lean();
    if (!row) return NextResponse.json({ error: "Not found" }, { status: 404 });
    await SlackConnectionModel.deleteOne({ _id: connectionId });
    if (row.isDefault) {
      const next = await SlackConnectionModel.findOne({ orgId: ctx.orgId }).sort({ createdDate: 1 }).select({ _id: 1 }).lean();
      if (next) await SlackConnectionModel.updateOne({ _id: next._id }, { $set: { isDefault: true } });
    }
    void recordActivity({
      orgId: ctx.orgId,
      userId: ctx.userId,
      actorKind: "user",
      type: "integration.slack_disconnected",
      meta: { channelName: row.channelName, teamName: row.teamName },
      request,
    });
    const rows = await listSlackConnections(ctx.orgId);
    return NextResponse.json({ ok: true, connections: rows.map(serializeSlackConnection) });
  });
}
