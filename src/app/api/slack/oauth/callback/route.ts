/**
 * `GET /api/slack/oauth/callback` — Slack sends the person back here after they picked a channel.
 *
 * Trusts nothing from the query but the signed `state` (workspace, person, expiry) and the
 * `code`, which is exchanged server-side at `oauth.v2.access` with the app's secret. The answer
 * carries `incoming_webhook { url, channel, channel_id, configuration_url }` and `team`; the URL
 * is encrypted before it is stored. A second install of the same channel updates the row (new
 * URL, back to `active`) rather than creating a twin. The first channel a workspace connects
 * becomes its default.
 *
 * Every failure redirects to the Slack page with `?slack=error&reason=…` and stores nothing.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { recordActivity } from "@/lib/activity/log";
import { SlackConnectionModel } from "@/lib/models/SlackConnection";
import { SLACK_OAUTH_ACCESS_URL, slackAppConfig, slackRedirectUri } from "@/lib/slack/config";
import { encryptSlackSecret } from "@/lib/slack/crypto";
import { verifySlackInstallState } from "@/lib/slack/state";
import { resolveConfiguredSiteUrl } from "@/lib/urls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const SLACK_PAGE = "/integrations/slack";

function back(reason: string | null): NextResponse {
  const base = resolveConfiguredSiteUrl()?.origin ?? "http://localhost:3001";
  const url = new URL(SLACK_PAGE, base);
  if (reason) {
    url.searchParams.set("slack", "error");
    url.searchParams.set("reason", reason);
  } else {
    url.searchParams.set("slack", "connected");
  }
  return NextResponse.redirect(url.toString(), { status: 302 });
}

type AccessResponse = {
  ok?: boolean;
  error?: string;
  access_token?: string;
  team?: { id?: string; name?: string };
  incoming_webhook?: { url?: string; channel?: string; channel_id?: string; configuration_url?: string };
};

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams;
  const state = verifySlackInstallState(query.get("state"));
  if (!state) return back("state");
  if (query.get("error")) return back(query.get("error") === "access_denied" ? "denied" : "slack");
  const code = (query.get("code") ?? "").trim();
  if (!code) return back("code");

  const app = slackAppConfig();
  const redirectUri = slackRedirectUri();
  if (!app || !redirectUri) return back("not_configured");
  if (!Types.ObjectId.isValid(state.orgId) || !Types.ObjectId.isValid(state.userId)) return back("state");

  let data: AccessResponse | null = null;
  try {
    const res = await fetch(SLACK_OAUTH_ACCESS_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri }),
      signal: AbortSignal.timeout(10_000),
    });
    data = (await res.json().catch(() => null)) as AccessResponse | null;
  } catch {
    return back("exchange");
  }
  const hook = data?.incoming_webhook;
  if (!data?.ok || !hook?.url || !hook.channel_id || !hook.channel || !data.team?.id) {
    return back(data?.error ? data.error.slice(0, 40) : "exchange");
  }

  const orgId = new Types.ObjectId(state.orgId);
  const userId = new Types.ObjectId(state.userId);
  await connectMongo();
  const others = await SlackConnectionModel.countDocuments({ orgId, channelId: { $ne: hook.channel_id } });
  const teamName = (data.team.name ?? "").trim() || "Slack";
  await SlackConnectionModel.updateOne(
    { orgId, channelId: hook.channel_id },
    {
      $setOnInsert: { orgId, channelId: hook.channel_id, installedByUserId: userId, isDefault: others === 0, projectIds: [] },
      $set: {
        teamId: data.team.id,
        teamName,
        channelName: hook.channel,
        webhookUrlEnc: encryptSlackSecret(hook.url),
        configurationUrl: hook.configuration_url ?? null,
        status: "active",
        lastError: null,
        consecutiveFailures: 0,
      },
    },
    { upsert: true },
  );
  void recordActivity({
    orgId,
    userId,
    actorKind: "user",
    type: "integration.slack_connected",
    meta: { channelName: hook.channel, teamName },
    request,
  });
  return back(null);
}
