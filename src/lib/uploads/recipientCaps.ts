/**
 * Daily caps for recipient uploads (request links and replace links).
 *
 * A recipient upload runs the automatic AI summary at the owner's expense in compute but at 0
 * credits (see `recordUnbilledRun`), so without a brake a public link could be used to burn model
 * cost indefinitely. Two independent caps, both per rolling 24h:
 * - per link token: `RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY` uploads,
 * - per Free workspace, across all its links: `FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY`.
 * Pro workspaces have only the per-token cap.
 */
import { Types } from "mongoose";

import { getWorkspacePlan } from "@/lib/billing/planLimits";
import { rateLimit } from "@/lib/http/rateLimit";
import { DocModel } from "@/lib/models/Doc";
import { UploadModel } from "@/lib/models/Upload";

export const RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY = 20;
export const FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY = 20;
export const RECIPIENT_UPLOAD_LIMIT_CODE = "RECIPIENT_UPLOAD_LIMIT";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * How much slack the atomic reservation gets over the document count.
 *
 * The reservation counts *attempts* (this function is called before anything is created), while
 * the counts below count *documents that actually landed*. A recipient who opens the file picker
 * and walks away, or whose browser retries a flaky upload, spends an attempt and creates nothing —
 * so a reservation ceiling equal to the cap would lock a genuine recipient out for a day over
 * uploads that never happened. With headroom the document counts stay the real limit and the
 * reservation is only what stops a burst from sailing past them, bounding a parallel flood at
 * `limit * headroom` instead of "however many requests fit in one round trip".
 */
const RECIPIENT_UPLOAD_BURST_HEADROOM = 2;

export type RecipientCapResult =
  | { ok: true }
  | { ok: false; scope: "token" | "workspace"; limit: number; message: string };

/**
 * Take one atomic slot out of a rolling-day bucket, returning whether it was still available.
 *
 * `rateLimit`'s hot path is a single upsert + `$inc` `findOneAndUpdate`, so unlike a
 * `countDocuments` read it has no window in which two callers can both see the same free slot.
 * It fails open when Mongo is unreachable, which is the right direction here: the counts in
 * `checkRecipientUploadCap` are still in force, they are just no longer race-proof.
 */
async function reserveDailySlot(key: string, limit: number, now: Date): Promise<boolean> {
  const result = await rateLimit({
    key,
    limit: limit * RECIPIENT_UPLOAD_BURST_HEADROOM,
    windowMs: DAY_MS,
    now: now.getTime(),
  });
  return result.ok;
}

/**
 * Checks the caps for one more upload through a request link (`requestProjectId`) or a replace
 * link (`replaceDocId`). The caller creates the upload only on `ok`.
 *
 * Not read-only any more, and deliberately so. It used to be `countDocuments(...) >= LIMIT` and
 * nothing else, with the caller's `DocModel.create` happening afterwards — so every request in a
 * parallel burst read the same pre-burst count, passed, and created. The 20/day brake was worth
 * whatever concurrency an attacker could open at once on a link that needs no sign-in. Each count
 * is now backed by an atomic reservation on the shared `ratelimits` collection, which cannot be
 * raced; the counts stay because a limiter bucket is disposable (TTL reap, a manual flush) while
 * the documents it was standing in for are not.
 *
 * Errors: DB failures propagate.
 */
export async function checkRecipientUploadCap(params: {
  orgId: Types.ObjectId;
  requestProjectId?: Types.ObjectId | null;
  replaceDocId?: Types.ObjectId | null;
  now?: Date;
}): Promise<RecipientCapResult> {
  const now = params.now ?? new Date();
  const since = new Date(now.getTime() - DAY_MS);

  const tokenLimitExceeded: RecipientCapResult = {
    ok: false,
    scope: "token",
    limit: RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY,
    message: `This link has received ${RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY} uploads in the last 24 hours. Try again later.`,
  };

  let tokenCount = 0;
  // One bucket per link, so two links on the same workspace cannot eat each other's allowance.
  let tokenKey: string | null = null;
  if (params.requestProjectId) {
    tokenKey = `recipient-upload:token:${params.requestProjectId.toString()}`;
    tokenCount = await DocModel.countDocuments({
      receivedViaRequestProjectId: params.requestProjectId,
      createdDate: { $gte: since },
    });
  } else if (params.replaceDocId) {
    tokenKey = `recipient-upload:doc:${params.replaceDocId.toString()}`;
    tokenCount = await UploadModel.countDocuments({
      docId: params.replaceDocId,
      uploadSecret: { $ne: null },
      createdDate: { $gte: since },
    });
  }
  if (tokenCount >= RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY) {
    return tokenLimitExceeded;
  }
  if (tokenKey && !(await reserveDailySlot(tokenKey, RECIPIENT_UPLOADS_PER_TOKEN_PER_DAY, now))) {
    return tokenLimitExceeded;
  }

  const plan = await getWorkspacePlan(params.orgId).catch(() => "free" as const);
  if (plan !== "pro") {
    const workspaceLimitExceeded: RecipientCapResult = {
      ok: false,
      scope: "workspace",
      limit: FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY,
      message: `This workspace has received ${FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY} uploads through links in the last 24 hours. Try again later.`,
    };
    const workspaceCount = await UploadModel.countDocuments({
      orgId: params.orgId,
      uploadSecret: { $ne: null },
      createdDate: { $gte: since },
    });
    if (workspaceCount >= FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY) {
      return workspaceLimitExceeded;
    }
    const workspaceKey = `recipient-upload:org:${params.orgId.toString()}`;
    if (!(await reserveDailySlot(workspaceKey, FREE_RECIPIENT_UPLOADS_PER_WORKSPACE_PER_DAY, now))) {
      return workspaceLimitExceeded;
    }
  }
  return { ok: true };
}
