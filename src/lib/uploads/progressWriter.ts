/**
 * Writes upload progress to the Upload row, throttled, and never at the pipeline's expense.
 *
 * One reporter per run. It holds the last percent and the last write time so the render loop can
 * call it on every page without turning a fifty-page deck into fifty writes (see
 * `shouldWriteProgress`), and it swallows everything: a progress write is a nicety, and a Mongo
 * blip during it must not cost someone their upload. `progress.orgId` is stamped alongside so the
 * realtime server can route the frame to a workspace room straight off the change stream, with no
 * second lookup per page.
 */
import { Types } from "mongoose";

import { debugLog } from "@/lib/debug";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";
import {
  PROGRESS_MIN_INTERVAL_MS,
  shouldWriteProgress,
  uploadProgressFor,
  type UploadStageKey,
} from "@/lib/uploads/progress";

export type ReportOptions = {
  /** Position inside the render band; only meaningful for the `rendering` stage. */
  page?: number | null;
  pages?: number | null;
  /** Skip the throttle. Used for the first write of a run and for `ready`/`failed`. */
  force?: boolean;
  /** Pin the bar instead of taking the stage's percent (a failure keeps where it got to). */
  percent?: number | null;
};

export type UploadProgressReporter = {
  /** Record a stage. Resolves once the write is done (or skipped); never rejects. */
  report(stage: UploadStageKey, options?: ReportOptions): Promise<void>;
  /** The percent last written, so a failure can pin the bar where it stopped. */
  lastPercent(): number | null;
};

/** A reporter that does nothing, for callers without a usable upload id. */
function noopReporter(): UploadProgressReporter {
  return { report: async () => undefined, lastPercent: () => null };
}

/**
 * Build the reporter for one upload run.
 *
 * `orgId` may be omitted: the reporter resolves it from the document once, on the first write, and
 * caches it. Passing it (the process job already knows it) saves that query.
 */
export function createUploadProgressReporter(params: {
  uploadId: string;
  docId?: string | null;
  orgId?: string | null;
  minIntervalMs?: number;
}): UploadProgressReporter {
  const uploadId = String(params.uploadId ?? "");
  if (!Types.ObjectId.isValid(uploadId)) return noopReporter();

  const minIntervalMs = typeof params.minIntervalMs === "number" ? params.minIntervalMs : PROGRESS_MIN_INTERVAL_MS;
  let lastPercent: number | null = null;
  let lastWriteAt: number | null = null;
  let orgId: string | null =
    params.orgId && Types.ObjectId.isValid(String(params.orgId)) ? String(params.orgId) : null;
  let docId: string | null = params.docId && Types.ObjectId.isValid(String(params.docId)) ? String(params.docId) : null;
  let orgLookupDone = Boolean(orgId);

  /** The document is the authority on which workspace an upload belongs to (uploads may predate `orgId`). */
  async function resolveOrgId(): Promise<void> {
    if (orgLookupDone) return;
    orgLookupDone = true;
    try {
      const upload = docId
        ? null
        : await UploadModel.findById(uploadId).select({ docId: 1, orgId: 1 }).lean();
      if (upload?.docId) docId = String(upload.docId);
      if (!orgId && upload?.orgId) orgId = String(upload.orgId);
      if (!orgId && docId) {
        const doc = await DocModel.findById(docId).select({ orgId: 1 }).lean();
        const raw = doc && (doc as { orgId?: unknown }).orgId;
        if (raw && Types.ObjectId.isValid(String(raw))) orgId = String(raw);
      }
    } catch {
      // A missing orgId only costs the live frame, not the upload.
    }
  }

  return {
    lastPercent: () => lastPercent,
    async report(stage: UploadStageKey, options?: ReportOptions): Promise<void> {
      try {
        // A failure keeps the bar where it stopped. When this reporter did not write the earlier
        // stages (the process route's crash handler builds a fresh one), read back what the row
        // already says rather than snapping a half-finished upload to zero.
        let pinned = options?.percent ?? null;
        if (pinned === null && stage === "failed") {
          pinned = lastPercent;
          if (pinned === null) {
            const row = await UploadModel.findById(uploadId).select({ progress: 1 }).lean().catch(() => null);
            const p = row && (row as { progress?: { percent?: unknown } }).progress?.percent;
            pinned = typeof p === "number" && Number.isFinite(p) ? p : null;
          }
        }
        const { percent, stage: text } = uploadProgressFor({
          stage,
          page: options?.page ?? null,
          pages: options?.pages ?? null,
          percent: pinned,
        });
        const now = Date.now();
        if (!shouldWriteProgress({ percent, lastPercent, lastWriteAt, now, force: options?.force, minIntervalMs })) {
          return;
        }
        await resolveOrgId();
        lastPercent = percent;
        lastWriteAt = now;
        await UploadModel.updateOne(
          { _id: new Types.ObjectId(uploadId) },
          {
            $set: {
              progress: {
                percent,
                stage: text,
                stageKey: stage,
                // The change stream's routing key — see `realtime/server.ts`.
                orgId: orgId ? new Types.ObjectId(orgId) : null,
                docId: docId ? new Types.ObjectId(docId) : null,
                updatedAt: new Date(now),
              },
              // Backfill the row's own workspace while we are here; `GET /api/uploads/:id` already
              // treats it as a fallback, and the in-flight list selects on it.
              ...(orgId ? { orgId: new Types.ObjectId(orgId) } : {}),
            },
          },
        );
      } catch (e) {
        debugLog(2, "[uploads] progress write failed (ignored)", {
          uploadId,
          stage,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    },
  };
}
