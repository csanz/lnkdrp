/**
 * `GET /api/slack/install` — start the Slack install for the active workspace.
 *
 * Owner or admin only (a viewer must not be able to point the workspace's traffic at a channel).
 * Signs a `state` naming the workspace and the person, then redirects to Slack's authorize page
 * with the `incoming-webhook` scope, which is what makes Slack show the channel picker. The
 * callback (`/api/slack/oauth/callback`) verifies that `state` before storing anything.
 *
 * 503 when the deployment has no Slack app configured; the Integrations page already says so.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { resolveActor } from "@/lib/gating/actor";
import { forbidApiKey } from "@/lib/gating/forbidApiKey";
import { requireOrgRole } from "@/lib/orgs/requireOrgRole";
import { SLACK_OAUTH_AUTHORIZE_URL, SLACK_SCOPE, slackAppConfig, slackRedirectUri } from "@/lib/slack/config";
import { createSlackInstallState } from "@/lib/slack/state";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const actor = await resolveActor(request);
  if (actor.kind !== "user") return NextResponse.json({ error: "Sign in to connect Slack." }, { status: 401 });
  if (!Types.ObjectId.isValid(actor.userId) || !Types.ObjectId.isValid(actor.orgId)) {
    return NextResponse.json({ error: "Invalid workspace" }, { status: 400 });
  }
  const keyForbidden = forbidApiKey(actor, "connect Slack");
  if (keyForbidden) return keyForbidden;
  const role = await requireOrgRole({ orgId: actor.orgId, userId: actor.userId, minRole: "admin" });
  if (!role.ok) return NextResponse.json({ error: "Only an owner or admin can connect Slack for this workspace." }, { status: 403 });

  const app = slackAppConfig();
  const redirectUri = slackRedirectUri();
  if (!app || !redirectUri) {
    return NextResponse.json({ error: "Slack is not set up on this deployment.", code: "SLACK_NOT_CONFIGURED" }, { status: 503 });
  }

  const state = createSlackInstallState({ orgId: actor.orgId, userId: actor.userId });
  const url = new URL(SLACK_OAUTH_AUTHORIZE_URL);
  url.searchParams.set("client_id", app.clientId);
  url.searchParams.set("scope", SLACK_SCOPE);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  return NextResponse.redirect(url.toString(), { status: 302 });
}
