/**
 * The visit brief's clock, as the write the stats ingest makes (docs/prds/lnkdrp-visit-briefs.md).
 *
 * In its own module so the public ingest route pulls in the `VisitBrief` model and nothing else:
 * the engine in `visitBriefs.ts` imports the credit service, the model client and the whole
 * notification sender, none of which belong in the import graph of the busiest write path in the
 * product.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { VisitBriefModel } from "@/lib/models/VisitBrief";
import { splitProjectViewerKey } from "@/lib/analytics/project/viewerKey";
import { rateLimit } from "@/lib/http/rateLimit";
import { debugError } from "@/lib/debug";

/** A visit is over when nothing has been heard from it for this long. See `visitBriefs.ts` for why 2 min. */
export const VISIT_QUIET_MS = 2 * 60 * 1000;

/**
 * New sittings one link may open in an hour. Past it the clock still moves on sittings that
 * already exist, but no further row is created until the hour turns over.
 *
 * What went wrong: `visitId` is a value the caller picks and this route is public, so every new
 * id a stranger holding the share slug posted planted a fresh `VisitBrief` row, and the cron
 * turned each row into a charged AI run. One forwarded slug could therefore spend a Pro
 * workspace's credits a credit at a time, at whatever rate the poster liked. The bound is per
 * LINK per hour because that is the one thing the recipient cannot forge: they choose the visit
 * id, the device id and the address, but not which slug they are posting to. A genuine link sees
 * far fewer than thirty new tabs in an hour; a forger gets thirty tries and then the hour is
 * spent. The per-workspace ceiling in `visitBriefs.ts` is the hard stop behind this one.
 */
export const NEW_SITTINGS_PER_LINK_PER_HOUR = 30;

/** The window the bound above is counted over. */
export const NEW_SITTINGS_WINDOW_MS = 60 * 60 * 1000;

/** The rate-limit bucket one share link's new sittings are counted in. */
export function newSittingBucketKey(shareId: string): string {
  return `visitbrief:new:${shareId}`;
}

export type ScheduleVisitBriefInput = {
  orgId: string | Types.ObjectId;
  /** The document being read. On a project link it goes in `stats.docs` later; `docId` stays null. */
  docId: string | Types.ObjectId;
  projectId?: string | Types.ObjectId | null;
  shareLinkId?: string | Types.ObjectId | null;
  shareId: string;
  visitIdHash: string;
  /** The PERSON: the bare digest, never the `<digest>.<docId>` composite. */
  botIdHash: string;
  isOwnerPreview: boolean;
  viewerUserId?: string | Types.ObjectId | null;
  viewerName?: string | null;
  viewerEmail?: string | null;
  /** The instant of this event, i.e. the visit's new `lastEventAt`. */
  at: Date;
};

/** `dueAt` for an event at `at`. Pure, for tests. */
export function dueAtFor(at: Date, quietMs = VISIT_QUIET_MS): Date {
  return new Date(at.getTime() + quietMs);
}

function toObjectId(v: string | Types.ObjectId | null | undefined): Types.ObjectId | null {
  if (!v) return null;
  const s = String(v);
  return Types.ObjectId.isValid(s) ? new Types.ObjectId(s) : null;
}

/**
 * Write down that a visit is in progress and when to look at it again. Never throws.
 *
 * `$max` on `lastEventAt`/`dueAt` so a heartbeat that arrives out of order cannot pull the deadline
 * back; `$setOnInsert` for the identity, so the first write creates the row and every later one
 * only moves the clock. `isOwnerPreview` and the viewer fields are `$set`, as on `ShareView`: a row
 * first written while signed out self-heals once they sign in or introduce themselves.
 *
 * Two steps rather than one upsert, because creating a row and moving a clock are not equally
 * cheap. An event for a sitting that already exists matches and returns in one write, as before.
 * Only an event that would CREATE a sitting is counted against
 * {@link NEW_SITTINGS_PER_LINK_PER_HOUR}, because that is the write a stranger with the slug can
 * mint at will by inventing a new `visitId`, and each one becomes a charged AI run.
 */
export async function scheduleVisitBrief(input: ScheduleVisitBriefInput): Promise<void> {
  try {
    const orgId = toObjectId(input.orgId);
    const docId = toObjectId(input.docId);
    const shareId = (input.shareId ?? "").trim();
    const visitIdHash = (input.visitIdHash ?? "").trim();
    const botIdHash = splitProjectViewerKey((input.botIdHash ?? "").trim()).botIdHash;
    if (!orgId || !docId || !shareId || !visitIdHash || !botIdHash) return;
    const projectId = toObjectId(input.projectId);

    const set: Record<string, unknown> = { isOwnerPreview: Boolean(input.isOwnerPreview) };
    const viewerUserId = toObjectId(input.viewerUserId);
    if (viewerUserId) set.viewerUserId = viewerUserId;
    if (typeof input.viewerName === "string" && input.viewerName.trim()) set.viewerName = input.viewerName.trim().slice(0, 300);
    if (typeof input.viewerEmail === "string" && input.viewerEmail.trim()) {
      set.viewerEmail = input.viewerEmail.trim().toLowerCase().slice(0, 320);
    }

    await connectMongo();
    const update = {
      $setOnInsert: {
        orgId,
        docId: projectId ? null : docId,
        projectId,
        shareLinkId: toObjectId(input.shareLinkId),
        botIdHash,
        startedAt: input.at,
        status: "scheduled",
        attempts: 0,
      },
      $set: set,
      $max: { lastEventAt: input.at, dueAt: dueAtFor(input.at) },
    };
    // The sitting already exists: move its clock and stop. `$setOnInsert` is inert without upsert.
    const moved = await VisitBriefModel.updateOne({ shareId, visitIdHash }, update);
    if (Number(moved?.matchedCount ?? 0) > 0) return;

    // A new sitting. One atomic bucket per link per hour, so a caller inventing visit ids cannot
    // keep planting rows for the cron to bill.
    const allowance = await rateLimit({
      key: newSittingBucketKey(shareId),
      limit: NEW_SITTINGS_PER_LINK_PER_HOUR,
      windowMs: NEW_SITTINGS_WINDOW_MS,
      now: input.at.getTime(),
    });
    if (!allowance.ok) {
      debugError(1, "[visit-briefs] new sittings per hour reached for this link; not scheduling", { shareId });
      return;
    }
    await VisitBriefModel.updateOne({ shareId, visitIdHash }, update, { upsert: true });
  } catch (err) {
    // A duplicate key here is two first heartbeats racing; the row exists and the next one moves it.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/E11000|duplicate key/i.test(msg)) debugError(1, "[visit-briefs] schedule failed", { message: msg });
  }
}

