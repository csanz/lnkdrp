/**
 * Plan-limit grace period sweep (Free workspaces).
 *
 * Free workspaces that are over a Free limit (shared documents, projects, collaborators) get a
 * `LIMIT_GRACE_DAYS` window before new documents/projects are blocked. State lives on
 * `Org.planGrace = { startedAt, endsAt, blockedAt, remindersSent }` and is advanced by this sweep:
 *
 * - over limit, no grace   → start grace, email owners ("started"), activity `plan.grace_started`
 * - in grace, day 7 / 12   → email owners ("reminder"), activity `plan.grace_reminder`
 *                            (deduped by day bucket via `remindersSent`)
 * - in grace, past endsAt  → set `blockedAt`, email owners ("blocked"), activity `plan.grace_blocked`
 * - back under all limits  → clear `planGrace` (they fixed it)
 * - now on Pro             → clear `planGrace`, activity `plan.upgraded` (once)
 *
 * Emails and activity rows are best-effort per workspace; failures are counted in `errors` and
 * never abort the sweep. `checkLimit()` in `planLimits.ts` reads the same `planGrace` state to
 * decide whether an over-limit workspace is still allowed to create (inside the window) or blocked.
 */
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { PRO_KIND_FILTER } from "@/lib/billing/subscriptionState";
import { UserModel } from "@/lib/models/User";
import { getMetadataBaseUrl } from "@/lib/urls";
import { recordActivity, type ActivityType } from "@/lib/activity/log";
import { sendPlanLimitEmail, type PlanLimitEmailKind } from "@/lib/email/sendPlanLimitEmail";
import { getWorkspaceUsage, limitsForPlan, LIMIT_GRACE_DAYS } from "@/lib/billing/planLimits";
import { debugLog, debugError } from "@/lib/debug";

const DAY_MS = 24 * 60 * 60 * 1000;

/** Days after `startedAt` at which a reminder is due (each sent at most once). */
const REMINDER_DAYS: readonly number[] = [7, 12];

/** Subscription statuses that can be Pro (with `PRO_KIND_FILTER`, mirrors `getWorkspacePlan`). */
const PRO_STATUSES = ["active", "trialing"] as const;

/** Activity types emitted by this sweep (members of `ActivityType`). */
const PLAN_ACTIVITY = {
  started: "plan.grace_started",
  reminder: "plan.grace_reminder",
  blocked: "plan.grace_blocked",
  upgraded: "plan.upgraded",
} as const satisfies Record<string, ActivityType>;

/** Persisted grace state on `Org.planGrace`. */
export type OrgPlanGrace = {
  startedAt: Date;
  endsAt: Date;
  blockedAt: Date | null;
  remindersSent: Date[];
};

type OrgGraceRow = {
  _id: Types.ObjectId;
  name?: string | null;
  planGrace?: OrgPlanGrace | null;
};

export type PlanLimitsGraceSweepOptions = {
  /** Reference time (defaults to wall clock; injectable for tests/backfills). */
  now?: Date;
  /** When true, compute transitions and counts but write nothing and send nothing. */
  dryRun?: boolean;
  /**
   * Max workspaces scanned per run (default 500). Workspaces already in grace are visited first,
   * then the least recently scanned of the rest: the budget is a rotation through the collection,
   * not a window onto one end of it.
   */
  limit?: number;
};

export type PlanLimitsGraceSweepResult = {
  scanned: number;
  started: number;
  reminded: number;
  blocked: number;
  errors: number;
  /** Grace cleared because the workspace dropped back under all Free limits. */
  cleared: number;
  /** Grace cleared because the workspace is now on Pro. */
  upgraded: number;
  dryRun: boolean;
};

type Usage = { documents: number; projects: number; members: number };

/** Whether `usage` exceeds any Free limit. */
function isOverFreeLimits(usage: Usage): boolean {
  const limits = limitsForPlan("free");
  if (limits.documents !== null && usage.documents > limits.documents) return true;
  if (limits.projects !== null && usage.projects > limits.projects) return true;
  if (Math.max(0, usage.members - 1) > limits.collaborators) return true;
  return false;
}

/** Whole days elapsed since `startedAt` at `at` (floored; never negative). */
function dayBucket(startedAt: Date, at: Date): number {
  return Math.max(0, Math.floor((at.getTime() - startedAt.getTime()) / DAY_MS));
}

/**
 * Which reminder day is due at `now`, or null.
 *
 * Only the latest due day is considered (a run that resumes after downtime sends one reminder,
 * not a backlog), and a reminder counts as sent when any `remindersSent` entry falls in that
 * day bucket or later.
 */
function dueReminderDay(grace: OrgPlanGrace, now: Date): number | null {
  const elapsed = dayBucket(grace.startedAt, now);
  const due = [...REMINDER_DAYS].reverse().find((d) => elapsed >= d) ?? null;
  if (due === null) return null;
  const alreadySent = (grace.remindersSent ?? []).some((sent) => dayBucket(grace.startedAt, new Date(sent)) >= due);
  return alreadySent ? null : due;
}

/** Absolute `/pricing` URL for email copy. */
function pricingUrl(): string {
  return new URL("/pricing", getMetadataBaseUrl()).toString();
}

/** Set of orgIds that currently have a Pro subscription (active/trialing). */
async function loadProOrgIds(): Promise<Set<string>> {
  const rows = await SubscriptionModel.find({ status: { $in: [...PRO_STATUSES] }, ...PRO_KIND_FILTER, isDeleted: { $ne: true } })
    .select({ orgId: 1 })
    .lean();
  return new Set(rows.map((r) => String(r.orgId)));
}

/** Owner memberships → `{ userId, email }` (temp users and users without email are skipped). */
async function loadOwners(orgId: Types.ObjectId): Promise<Array<{ userId: Types.ObjectId; email: string }>> {
  const memberships = await OrgMembershipModel.find({ orgId, role: "owner", isDeleted: { $ne: true } })
    .select({ userId: 1 })
    .lean();
  const userIds = memberships.map((m) => m.userId).filter(Boolean);
  if (!userIds.length) return [];
  const users = await UserModel.find({ _id: { $in: userIds }, isTemp: { $ne: true } })
    .select({ email: 1 })
    .lean();
  const out: Array<{ userId: Types.ObjectId; email: string }> = [];
  for (const u of users) {
    const email = typeof u.email === "string" ? u.email.trim() : "";
    if (email) out.push({ userId: u._id as Types.ObjectId, email });
  }
  return out;
}

/**
 * Load the workspaces to scan this run: every org already in grace first (they need timely
 * transitions), then the least recently scanned orgs without grace to fill the remaining budget.
 *
 * The second half used to sort `{ _id: -1 }`. ObjectIds are creation-ordered, so that was a fixed
 * newest-first prefix: once the collection held more workspaces than the run budget (500 by
 * default), the same newest 500 were re-read every hour and nothing older was ever looked at.
 * Nothing in a run mutates a workspace it skipped, so the next run picked the identical set, for
 * ever. That is backwards for this job in particular: a Free workspace can only be *over* a limit
 * by having dropped from Pro (or gained a member), because `checkLimit` refuses the create that
 * would take it over in the first place, so the cohort that needs the window skews old. Those
 * owners got no `plan.grace_started`, no email and no 14 days, just a bare 402 on their next
 * upload, since `checkLimit` treats grace purely as an unblocker and `planGrace: null` falls
 * through to the block.
 *
 * `planLimitsScannedAt` (stamped by `markScanned` below) turns the budget back into a rotation:
 * null/missing sorts first ascending, so never-scanned workspaces lead and the window then walks
 * the whole collection run by run. Same shape as the doc-metrics rollup's stalest-snapshot-first
 * sort (`src/lib/metrics/rollupDocMetrics.ts`), for the same reason.
 */
async function loadCandidates(limit: number): Promise<OrgGraceRow[]> {
  const inGrace = await OrgModel.find({ isDeleted: { $ne: true }, planGrace: { $ne: null } })
    .select({ _id: 1, name: 1, planGrace: 1 })
    .sort({ "planGrace.endsAt": 1 })
    .limit(limit)
    .lean<OrgGraceRow[]>();
  const remaining = limit - inGrace.length;
  if (remaining <= 0) return inGrace;
  const fresh = await OrgModel.find({ isDeleted: { $ne: true }, planGrace: null })
    .select({ _id: 1, name: 1, planGrace: 1 })
    .sort({ planLimitsScannedAt: 1, _id: 1 })
    .limit(remaining)
    .lean<OrgGraceRow[]>();
  return [...inGrace, ...fresh];
}

/**
 * Stamp the workspaces this run looked at so the next run takes the ones behind them.
 *
 * Every scanned org is stamped, including one whose usage lookup threw: a workspace that fails
 * every time would otherwise sit at the head of the queue and starve everything behind it. One
 * bulk write per run, not one per workspace. A failed stamp only costs a repeated page next run,
 * but it is counted in `errors` all the same, because a stamp that fails *every* run is the
 * original bug back again and silent.
 */
async function markScanned(ids: Types.ObjectId[], now: Date, result: PlanLimitsGraceSweepResult): Promise<void> {
  if (!ids.length) return;
  try {
    await OrgModel.updateMany({ _id: { $in: ids } }, { $set: { planLimitsScannedAt: now } });
  } catch (err) {
    result.errors += 1;
    debugError(1, "[plan-limits] scan marker failed", {
      count: ids.length,
      message: err instanceof Error ? err.message : String(err),
    });
  }
}

type WorkspaceContext = {
  org: OrgGraceRow;
  usage: Usage;
  now: Date;
  dryRun: boolean;
  result: PlanLimitsGraceSweepResult;
};

/** Email every owner (best-effort per recipient; failures counted, never thrown). */
async function emailOwners(ctx: WorkspaceContext, kind: PlanLimitEmailKind, endsAt: Date): Promise<Types.ObjectId | null> {
  const owners = await loadOwners(ctx.org._id);
  const workspaceName = (ctx.org.name ?? "").trim() || "Your workspace";
  if (ctx.dryRun) {
    debugLog(1, "[plan-limits] dry-run email", { orgId: String(ctx.org._id), kind, to: owners.map((o) => o.email) });
    return owners[0]?.userId ?? null;
  }
  for (const owner of owners) {
    try {
      await sendPlanLimitEmail({
        to: owner.email,
        kind,
        workspaceName,
        usage: ctx.usage,
        endsAt,
        pricingUrl: pricingUrl(),
        now: ctx.now,
      });
    } catch (err) {
      ctx.result.errors += 1;
      debugError(1, "[plan-limits] email failed", {
        orgId: String(ctx.org._id),
        kind,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return owners[0]?.userId ?? null;
}

/** Record an activity row for the sweep (best-effort; `recordActivity` never throws). */
async function logActivity(ctx: WorkspaceContext, type: ActivityType, userId: Types.ObjectId | null, meta: Record<string, unknown>) {
  if (ctx.dryRun) return;
  await recordActivity({
    orgId: ctx.org._id,
    userId,
    actorKind: "user",
    agent: null,
    type,
    title: (ctx.org.name ?? "").trim() || null,
    meta: { source: "plan-limits-sweep", usage: ctx.usage, ...meta },
  });
}

async function setGrace(ctx: WorkspaceContext, grace: OrgPlanGrace | null): Promise<void> {
  if (ctx.dryRun) return;
  await OrgModel.updateOne({ _id: ctx.org._id }, { $set: { planGrace: grace } });
}

/** Advance one workspace through the grace lifecycle. */
async function processWorkspace(ctx: WorkspaceContext, isPro: boolean): Promise<void> {
  const { org, usage, now, result } = ctx;
  const grace = org.planGrace ?? null;

  // Upgraded to Pro while in grace → clear and record once.
  if (isPro) {
    if (grace) {
      await setGrace(ctx, null);
      result.upgraded += 1;
      await logActivity(ctx, PLAN_ACTIVITY.upgraded, null, { grace: serializeGrace(grace) });
    }
    return;
  }

  const over = isOverFreeLimits(usage);

  if (!over) {
    if (grace) {
      await setGrace(ctx, null);
      result.cleared += 1;
      debugLog(1, "[plan-limits] grace cleared (under limits)", { orgId: String(org._id) });
    }
    return;
  }

  // Over a Free limit.
  if (!grace) {
    const endsAt = new Date(now.getTime() + LIMIT_GRACE_DAYS * DAY_MS);
    await setGrace(ctx, { startedAt: now, endsAt, blockedAt: null, remindersSent: [now] });
    result.started += 1;
    const userId = await emailOwners(ctx, "started", endsAt);
    await logActivity(ctx, PLAN_ACTIVITY.started, userId, { startedAt: now.toISOString(), endsAt: endsAt.toISOString() });
    return;
  }

  if (grace.blockedAt) return; // Already blocked; nothing more to do until they fix it or upgrade.

  if (now.getTime() >= new Date(grace.endsAt).getTime()) {
    await setGrace(ctx, { ...grace, blockedAt: now });
    result.blocked += 1;
    const userId = await emailOwners(ctx, "blocked", new Date(grace.endsAt));
    await logActivity(ctx, PLAN_ACTIVITY.blocked, userId, { ...serializeGrace(grace), blockedAt: now.toISOString() });
    return;
  }

  const dueDay = dueReminderDay(grace, now);
  if (dueDay === null) return;
  await setGrace(ctx, { ...grace, remindersSent: [...(grace.remindersSent ?? []), now] });
  result.reminded += 1;
  const userId = await emailOwners(ctx, "reminder", new Date(grace.endsAt));
  await logActivity(ctx, PLAN_ACTIVITY.reminder, userId, { ...serializeGrace(grace), reminderDay: dueDay });
}

function serializeGrace(grace: OrgPlanGrace): Record<string, unknown> {
  return {
    startedAt: new Date(grace.startedAt).toISOString(),
    endsAt: new Date(grace.endsAt).toISOString(),
    blockedAt: grace.blockedAt ? new Date(grace.blockedAt).toISOString() : null,
  };
}

/**
 * Run one pass of the plan-limit grace sweep.
 *
 * Idempotent for a given `now`: state transitions are guarded by the persisted `planGrace`
 * (start only when null, block only once, reminders deduped by day bucket), so re-running or
 * overlapping ticks cannot double-email. Per-workspace failures are isolated and counted.
 */
export async function runPlanLimitsGraceSweep(
  opts: PlanLimitsGraceSweepOptions = {},
): Promise<PlanLimitsGraceSweepResult> {
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun === true;
  const limit = Number.isFinite(opts.limit) && (opts.limit as number) > 0 ? Math.floor(opts.limit as number) : 500;

  const result: PlanLimitsGraceSweepResult = {
    scanned: 0,
    started: 0,
    reminded: 0,
    blocked: 0,
    errors: 0,
    cleared: 0,
    upgraded: 0,
    dryRun,
  };

  await connectMongo();
  const proOrgIds = await loadProOrgIds();
  const orgs = await loadCandidates(limit);

  for (const org of orgs) {
    result.scanned += 1;
    const isPro = proOrgIds.has(String(org._id));
    try {
      // Pro workspaces without grace need no usage lookup.
      const usage: Usage = isPro && !org.planGrace ? { documents: 0, projects: 0, members: 0 } : await getWorkspaceUsage(org._id);
      await processWorkspace({ org, usage, now, dryRun, result }, isPro);
    } catch (err) {
      result.errors += 1;
      debugError(1, "[plan-limits] workspace failed", {
        orgId: String(org._id),
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // After the loop, so a workspace that threw is still moved to the back of the queue. A dry run
  // writes nothing, including this: it must not advance the rotation for the real run.
  if (!dryRun) await markScanned(orgs.map((o) => o._id), now, result);

  debugLog(1, "[plan-limits] sweep done", result);
  return result;
}
