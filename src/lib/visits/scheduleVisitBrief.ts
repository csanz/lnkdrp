/**
 * The visit brief's clock, as the one write the stats ingest makes (docs/prds/lnkdrp-visit-briefs.md).
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
import { debugError } from "@/lib/debug";

/** A visit is over when nothing has been heard from it for this long. See `visitBriefs.ts` for why 2 min. */
export const VISIT_QUIET_MS = 2 * 60 * 1000;

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
    await VisitBriefModel.updateOne(
      { shareId, visitIdHash },
      {
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
      },
      { upsert: true },
    );
  } catch (err) {
    // A duplicate key here is two first heartbeats racing; the row exists and the next one moves it.
    const msg = err instanceof Error ? err.message : String(err);
    if (!/E11000|duplicate key/i.test(msg)) debugError(1, "[visit-briefs] schedule failed", { message: msg });
  }
}

