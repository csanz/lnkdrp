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
import { ProjectModel } from "@/lib/models/Project";
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
  /** The reader put a name to their visit; posted under the Opens switch. */
  introduced?: boolean;
  /** Which document change this is (docUpdates rows); see the model. */
  change?: SlackDocChange | null;
  /** The new share link's row, for `change: "link_created"`. */
  linkId?: string | Types.ObjectId | null;
};

export type SlackDocChange = "replaced" | "created" | "added_to_project" | "link_created";

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

/**
 * Where an event may go: the document's rooms, the request inbox it arrived through, and the
 * event's own project. A contained document (`visibility: "project"`) routes on its home room
 * alone and never falls back to the catch-all (docs/prds/lnkdrp-project-home.md, decision 6).
 *
 * A **locked** room does the same, for a stronger reason (docs/prds/lnkdrp-locked-projects.md,
 * decision 20). A locked project exists only for the people holding a membership row, and the
 * catch-all channel is read by the whole Slack workspace, so falling back to it would publish a
 * private room's activity to exactly the people the lock exists to exclude — the room's name, its
 * documents and its readers. Locking a room does not contain its documents, so this is not already
 * covered by the branch above: an ordinary document in a locked room takes the path below.
 *
 * When any candidate room is locked the event routes to the locked rooms alone and never to the
 * default, even if the document also sits in an unlocked room. The unlocked room's channel is still
 * a channel this content was never cleared for, and a message naming the locked room is a leak
 * wherever it lands.
 *
 * The limit this cannot reach, recorded because no filter closes it: a Slack channel's audience is
 * Slack members, not `OrgMembership` rows. Routing a locked room to its own mapped channel is
 * correct here and still publishes it to everyone in that channel. That is the mapping warning's
 * job, not this function's.
 */
async function routingFor(orgId: Types.ObjectId, event: SlackOutboxEvent): Promise<{ projectIds: string[]; allowDefault: boolean }> {
  const out = new Set<string>();
  const direct = oid(event.projectId);
  if (direct) out.add(String(direct));
  const docId = oid(event.docId);
  if (docId) {
    const doc = (await DocModel.findOne({ _id: docId, orgId }).select({ projectIds: 1, primaryProjectId: 1, receivedViaRequestProjectId: 1, visibility: 1 }).lean()) as
      | { projectIds?: unknown[]; primaryProjectId?: unknown; receivedViaRequestProjectId?: unknown; visibility?: string }
      | null;
    if (doc?.visibility === "project") {
      const home = doc.primaryProjectId ? String(doc.primaryProjectId) : (doc.projectIds ?? []).map(String)[0];
      return { projectIds: home ? [home] : [], allowDefault: false };
    }
    for (const p of doc?.projectIds ?? []) if (p) out.add(String(p));
    if (doc?.receivedViaRequestProjectId) out.add(String(doc.receivedViaRequestProjectId));
  }
  const projectIds = Array.from(out);
  if (!projectIds.length) return { projectIds, allowDefault: true };

  // `$eq` and not `$ne`: this asks which rooms *are* locked, so a row written before the field
  // existed simply does not match, which is the answer we want.
  const locked = (await ProjectModel.find({ orgId, _id: { $in: projectIds.map((p) => new Types.ObjectId(p)) }, visibility: "locked" })
    .select({ _id: 1 })
    .lean()) as Array<{ _id: Types.ObjectId }>;
  if (locked.length) return { projectIds: locked.map((p) => String(p._id)), allowDefault: false };
  return { projectIds, allowDefault: true };
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
    const routing = await routingFor(orgId, input.event);
    const targets = routeSlackConnections(
      connections.map((c) => ({ ...serializeSlackConnection(c), row: c })),
      input.kind,
      routing.projectIds,
      { allowDefault: routing.allowDefault },
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
        introduced: input.event.introduced === true,
        change: input.event.change ?? null,
        linkId: oid(input.event.linkId),
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
