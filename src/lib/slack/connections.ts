/**
 * The workspace's Slack channels as the app and the API see them: never the webhook URL.
 */
import { Types } from "mongoose";

import { SlackConnectionModel, type SlackConnection } from "@/lib/models/SlackConnection";
import { decryptSlackSecret } from "./crypto";
import { postToSlackWebhook, type SlackMessage, type SlackPostOutcome } from "./post";

/**
 * The five moments a channel can receive. `docs` is the one about the workspace's own hands: a
 * document added to a project. The other four are about recipients and their files.
 */
export type SlackEventKey = "views" | "briefs" | "docUpdates" | "requests" | "docs";
export const SLACK_EVENT_KEYS: readonly SlackEventKey[] = ["views", "briefs", "docUpdates", "requests", "docs"];

/** What a member may see about a connection. No URL, no team id. */
/** What the integrations pages render: whether Slack is configured on this deployment, and the workspace's connections. */
export type SlackState = { enabled: boolean; connections: SlackConnectionDto[] };

export type SlackConnectionDto = {
  id: string;
  teamName: string;
  channelName: string;
  isDefault: boolean;
  projectIds: string[];
  events: Record<SlackEventKey, boolean>;
  status: "active" | "revoked";
  lastPostAt: string | null;
  lastError: string | null;
  configurationUrl: string | null;
  createdDate: string | null;
};

export function serializeSlackConnection(row: SlackConnection): SlackConnectionDto {
  const events = (row.events ?? {}) as Partial<Record<SlackEventKey, boolean>>;
  return {
    id: String(row._id),
    teamName: row.teamName,
    channelName: row.channelName,
    isDefault: Boolean(row.isDefault),
    projectIds: (row.projectIds ?? []).map((p) => String(p)),
    events: {
      views: events.views !== false,
      briefs: events.briefs !== false,
      docUpdates: events.docUpdates !== false,
      requests: events.requests !== false,
      docs: events.docs !== false,
    },
    status: row.status === "revoked" ? "revoked" : "active",
    lastPostAt: row.lastPostAt ? new Date(row.lastPostAt).toISOString() : null,
    lastError: row.lastError ?? null,
    configurationUrl: row.configurationUrl ?? null,
    createdDate: (row as { createdDate?: Date }).createdDate ? new Date((row as { createdDate?: Date }).createdDate!).toISOString() : null,
  };
}

export async function listSlackConnections(orgId: Types.ObjectId): Promise<SlackConnection[]> {
  return SlackConnectionModel.find({ orgId }).sort({ isDefault: -1, createdDate: 1 }).lean<SlackConnection[]>();
}

/**
 * Post one message through a connection and record the answer on the row: `lastPostAt` on
 * success, the failure count otherwise, and `revoked` when Slack says the webhook is dead or the
 * fifth failure in a row lands. Returns the outcome so a caller can retry or report.
 */
export async function postThroughConnection(connection: SlackConnection, message: SlackMessage): Promise<SlackPostOutcome> {
  const url = decryptSlackSecret(connection.webhookUrlEnc);
  if (!url) {
    await SlackConnectionModel.updateOne({ _id: connection._id }, { $set: { status: "revoked", lastError: "stored webhook could not be read" } });
    return { kind: "revoked", reason: "undecryptable" };
  }
  const outcome = await postToSlackWebhook(url, message);
  if (outcome.kind === "sent") {
    await SlackConnectionModel.updateOne({ _id: connection._id }, { $set: { lastPostAt: new Date(), lastError: null, consecutiveFailures: 0 } });
    return outcome;
  }
  if (outcome.kind === "revoked") {
    await SlackConnectionModel.updateOne(
      { _id: connection._id },
      { $set: { status: "revoked", lastError: outcome.reason }, $inc: { consecutiveFailures: 1 } },
    );
    return outcome;
  }
  const failures = (connection.consecutiveFailures ?? 0) + 1;
  await SlackConnectionModel.updateOne(
    { _id: connection._id },
    failures >= 5
      ? { $set: { status: "revoked", lastError: `${outcome.reason} (5 failures in a row)`, consecutiveFailures: failures } }
      : { $set: { lastError: outcome.reason, consecutiveFailures: failures } },
  );
  return failures >= 5 ? { kind: "revoked", reason: outcome.reason } : outcome;
}
