/**
 * The Slack outbox: write the rows at the event, post them at once, retry what failed from the
 * cron (docs/prds/lnkdrp-slack.md, decisions 4, 9, 10).
 *
 * `enqueueSlackPosts` is what the four event sites call. It resolves the target connections
 * (`routeSlackConnections`), writes one row per connection, and posts them immediately when
 * asked to. Every path here is best-effort and never throws into the caller: losing a Slack post
 * must never cost the request that caused it, and the cron picks up what the moment missed.
 *
 * `drainSlackOutbox` is the cron's half: claim due rows with a token (the same shape as
 * `claimBatch` in the notification queue), render, post serially per connection with the burst
 * cap, and record the outcome with the queue's backoff ladder.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { debugError, debugLog } from "@/lib/debug";
import { BACKOFF_MS, MAX_ATTEMPTS } from "@/lib/notifications/queue";
import { DocModel } from "@/lib/models/Doc";
import { SlackConnectionModel, type SlackConnection } from "@/lib/models/SlackConnection";
import { SlackOutboxModel, type SlackOutbox } from "@/lib/models/SlackOutbox";
import { postThroughConnection, serializeSlackConnection, type SlackEventKey } from "./connections";
import { renderSlackEvent, slackBurstMessage } from "./messages";
import { SLACK_BURST_PER_MINUTE, SLACK_BURST_WINDOW_MS, burstAllowance, routeSlackConnections } from "./routing";

export type SlackOutboxEvent = {
  docId?: string | Types.ObjectId | null;
  projectId?: string | Types.ObjectId | null;
  shareId?: string | null;
  shareViewId?: string | Types.ObjectId | null;
  uploadId?: string | Types.ObjectId | null;
  visitBriefId?: string | Types.ObjectId | null;
  viewerKey?: string | null;
  viewerName?: string | null;
  viewerEmail?: string | null;
  version?: number | null;
};

export type EnqueueSlackInput = {
  orgId: string | Types.ObjectId;
  kind: SlackEventKey;
  /** The ShareView, VisitBrief or Upload id: one post per source per connection. */
  sourceId: string;
  event: SlackOutboxEvent;
  occurredAt?: Date;
  /** Post right now (from `after()` or a cron), or leave it to the cron. Default: post now. */
  postNow?: boolean;
};

const oid = (v: string | Types.ObjectId | null | undefined): Types.ObjectId | null => {
  if (!v) return null;
  const s = String(v);
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
};

/** The document's projects plus the event's own, as strings, for routing. */
async function projectIdsFor(orgId: Types.ObjectId, event: SlackOutboxEvent): Promise<string[]> {
  const out = new Set<string>();
  const direct = oid(event.projectId);
  if (direct) out.add(String(direct));
  const docId = oid(event.docId);
  if (docId) {
    const doc = (await DocModel.findOne({ _id: docId, orgId }).select({ projectIds: 1 }).lean()) as { projectIds?: unknown[] } | null;
    for (const p of doc?.projectIds ?? []) if (p) out.add(String(p));
  }
  return Array.from(out);
}

/**
 * Write the rows for one event and, by default, post them. Answers how many rows were written
 * (0 when the workspace has no channel for this kind), never throws.
 */
export async function enqueueSlackPosts(input: EnqueueSlackInput): Promise<number> {
  try {
    const orgId = oid(input.orgId);
    if (!orgId || !input.sourceId) return 0;
    await connectMongo();
    const connections = await SlackConnectionModel.find({ orgId, status: "active" }).lean<SlackConnection[]>();
    if (!connections.length) return 0;
    const projectIds = await projectIdsFor(orgId, input.event);
    const targets = routeSlackConnections(
      connections.map((c) => ({ ...serializeSlackConnection(c), row: c })),
      input.kind,
      projectIds,
    );
    if (!targets.length) return 0;

    const occurredAt = input.occurredAt ?? new Date();
    const docs = targets.map((t) => ({
      orgId,
      connectionId: t.row._id,
      kind: input.kind,
      dedupeKey: `${input.kind}:${t.id}:${input.sourceId}`,
      event: {
        docId: oid(input.event.docId),
        projectId: oid(input.event.projectId),
        shareId: input.event.shareId ?? null,
        shareViewId: oid(input.event.shareViewId),
        uploadId: oid(input.event.uploadId),
        visitBriefId: oid(input.event.visitBriefId),
        viewerKey: input.event.viewerKey ?? null,
        viewerName: input.event.viewerName ?? null,
        viewerEmail: input.event.viewerEmail ?? null,
        version: typeof input.event.version === "number" ? input.event.version : null,
      },
      occurredAt,
      status: "pending",
      attempts: 0,
      nextAttemptAt: occurredAt,
    }));
    // `ordered: false` so a duplicate (the event fired twice) skips its row and the rest land.
    let inserted: SlackOutbox[] = [];
    try {
      inserted = (await SlackOutboxModel.insertMany(docs, { ordered: false })) as unknown as SlackOutbox[];
    } catch (err) {
      const e = err as { insertedDocs?: SlackOutbox[]; code?: number };
      inserted = Array.isArray(e?.insertedDocs) ? e.insertedDocs : [];
      if (e?.code !== 11000 && !Array.isArray(e?.insertedDocs)) throw err;
    }
    if (input.postNow !== false && inserted.length) {
      await drainSlackOutbox({ rowIds: inserted.map((r) => r._id), now: new Date() });
    }
    return inserted.length;
  } catch (err) {
    debugError(1, "[slack] enqueue failed", { kind: input.kind, message: err instanceof Error ? err.message : String(err) });
    return 0;
  }
}

export type DrainResult = { claimed: number; sent: number; retried: number; skipped: number; dead: number; revoked: number };

/**
 * Post what is due. Scoped to one workspace, to specific rows (the moment after an event), or
 * everything pending (the cron). Serial per connection with the burst cap; different connections
 * do not wait on each other.
 */
export async function drainSlackOutbox(params: { workspaceId?: string | Types.ObjectId | null; rowIds?: Types.ObjectId[]; now?: Date; limit?: number } = {}): Promise<DrainResult> {
  const result: DrainResult = { claimed: 0, sent: 0, retried: 0, skipped: 0, dead: 0, revoked: 0 };
  const now = params.now ?? new Date();
  try {
    await connectMongo();
    const filter: Record<string, unknown> = { status: "pending", nextAttemptAt: { $lte: now } };
    const orgId = oid(params.workspaceId);
    if (orgId) filter.orgId = orgId;
    if (params.rowIds?.length) filter._id = { $in: params.rowIds };
    const limit = Math.min(Math.max(params.limit ?? 200, 1), 500);

    const candidates = await SlackOutboxModel.find(filter).sort({ nextAttemptAt: 1, occurredAt: 1 }).limit(limit).select({ _id: 1 }).lean();
    const ids = candidates.map((c) => c._id as Types.ObjectId);
    if (!ids.length) return result;
    const claimToken = new Types.ObjectId().toHexString();
    await SlackOutboxModel.updateMany({ ...filter, _id: { $in: ids } }, { $set: { status: "sending", claimedAt: now, claimToken } });
    const rows = await SlackOutboxModel.find({ _id: { $in: ids }, claimToken }).sort({ occurredAt: 1 }).lean<SlackOutbox[]>();
    result.claimed = rows.length;
    if (!rows.length) return result;

    const byConnection = new Map<string, SlackOutbox[]>();
    for (const r of rows) {
      const k = String(r.connectionId);
      (byConnection.get(k) ?? byConnection.set(k, []).get(k)!).push(r);
    }
    const connections = await SlackConnectionModel.find({ _id: { $in: Array.from(byConnection.keys()).map((k) => new Types.ObjectId(k)) } }).lean<SlackConnection[]>();
    const connById = new Map(connections.map((c) => [String(c._id), c]));

    await Promise.all(
      Array.from(byConnection.entries()).map(async ([connectionId, batch]) => {
        const connection = connById.get(connectionId);
        if (!connection || connection.status !== "active") {
          await SlackOutboxModel.updateMany({ _id: { $in: batch.map((b) => b._id) } }, { $set: { status: "skipped", skippedReason: "connection_gone", claimToken: null } });
          result.skipped += batch.length;
          return;
        }
        // Burst cap: what this channel already received in the last minute bounds what it gets now.
        const sentInWindow = await SlackOutboxModel.countDocuments({ connectionId: connection._id, status: "sent", sentAt: { $gte: new Date(now.getTime() - SLACK_BURST_WINDOW_MS) } });
        const { allowed, held } = burstAllowance(sentInWindow, batch.length);
        const toPost = batch.slice(0, allowed);
        const toHold = batch.slice(allowed);
        if (toHold.length) {
          // Held rows go back to pending for the next window rather than being dropped, and one
          // line tells the channel it is behind. Skipped only when the same row is held again.
          const retryAt = new Date(now.getTime() + SLACK_BURST_WINDOW_MS);
          await SlackOutboxModel.updateMany(
            { _id: { $in: toHold.map((b) => b._id) } },
            { $set: { status: "pending", nextAttemptAt: retryAt, claimToken: null, lastError: "burst" } },
          );
          result.retried += held;
        }

        let dead = false;
        for (const row of toPost) {
          if (dead) {
            await SlackOutboxModel.updateOne({ _id: row._id }, { $set: { status: "skipped", skippedReason: "connection_revoked", claimToken: null } });
            result.skipped += 1;
            continue;
          }
          const message = await renderSlackEvent(row);
          if (!message) {
            await SlackOutboxModel.updateOne({ _id: row._id }, { $set: { status: "skipped", skippedReason: "source_gone", claimToken: null } });
            result.skipped += 1;
            continue;
          }
          const outcome = await postThroughConnection(connection, message);
          if (outcome.kind === "sent") {
            await SlackOutboxModel.updateOne({ _id: row._id }, { $set: { status: "sent", sentAt: new Date(), claimToken: null, lastError: null }, $inc: { attempts: 1 } });
            result.sent += 1;
            continue;
          }
          if (outcome.kind === "revoked") {
            dead = true;
            await SlackOutboxModel.updateOne({ _id: row._id }, { $set: { status: "skipped", skippedReason: `connection_revoked:${outcome.reason}`, claimToken: null } });
            result.skipped += 1;
            result.revoked += 1;
            continue;
          }
          const attempts = (row.attempts ?? 0) + 1;
          if (attempts >= MAX_ATTEMPTS) {
            await SlackOutboxModel.updateOne({ _id: row._id }, { $set: { status: "dead", lastError: outcome.reason, claimToken: null, attempts } });
            result.dead += 1;
          } else {
            const backoff = Math.max(outcome.afterMs, BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)] ?? 60_000);
            await SlackOutboxModel.updateOne(
              { _id: row._id },
              { $set: { status: "pending", nextAttemptAt: new Date(now.getTime() + backoff), lastError: outcome.reason, claimToken: null, attempts } },
            );
            result.retried += 1;
          }
        }
        if (toHold.length && !dead) {
          // One line, not thirty: the channel is told the rest is coming.
          await postThroughConnection(connection, slackBurstMessage({ held: toHold.length, cap: SLACK_BURST_PER_MINUTE }));
        }
      }),
    );
    debugLog(1, "[slack] drained", result);
  } catch (err) {
    debugError(1, "[slack] drain failed", { message: err instanceof Error ? err.message : String(err) });
  }
  return result;
}
