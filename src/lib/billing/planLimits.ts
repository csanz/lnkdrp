/**
 * Plan limits (Free vs Pro) and the enforcement helpers API routes call.
 *
 * Plan status lives in `SubscriptionModel` (one row per org; `active`/`trialing` = Pro). Free
 * workspaces are capped on shared documents, projects, and collaborators, and their viewer
 * analytics window is clamped. Pro workspaces are unlimited on all three counts.
 *
 * Feature gates: some `LimitKey`s are not counts but Pro-only features (`version_history`: letting
 * recipients browse a document's versions on the share page, since 2026-09-13 the only version
 * feature that is plan-gated; the owner's history page and AI compare run on credits on every plan;
 * `analytics_history`: deep
 * analytics, i.e. viewer identities, per-viewer rows, per-page time and visit timelines). They never
 * carry usage or grace; Free is simply blocked and Pro is always ok.
 *
 * Analytics tiers: Free gets BASIC analytics (totals, views-by-day series, total time on document,
 * a unique-viewer count, last `FREE_ANALYTICS_DAYS` days). Pro gets DEEP analytics (everything,
 * full history). Viewer identities are still recorded on Free; they are only withheld from Free
 * responses, so upgrading reveals them retroactively.
 *
 * Grace: a workspace that was already over a Free limit when enforcement shipped (or that just
 * dropped from Pro to Free) gets `LIMIT_GRACE_DAYS` before it is blocked. Grace state is stored on
 * `Org.planGrace` and managed by the grace cron; this module only reads it. Grace never applies to
 * feature gates.
 *
 * Client contract: a `402` with `code: "plan_limit"` (see `planLimitResponse`) is the signal to
 * show an upgrade prompt; the JSON body carries everything needed to render it.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";
import { connectMongo } from "@/lib/mongodb";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { DocModel } from "@/lib/models/Doc";
import { ProjectModel } from "@/lib/models/Project";
import { SubscriptionModel } from "@/lib/models/Subscription";
// The share-links service owns the definition of "an active link"; importing it here keeps the
// cap and the link routes from ever disagreeing (the cycle is import-only: both sides call at runtime).

/**
 * Free plan: **documents** with sharing enabled (not deleted, not archived).
 *
 * Documents, never share links. A document owns as many links as its sender needs — one per
 * investor, per counterparty, per audience — and that is the product's headline feature, so making
 * links the thing you run out of turns the feature into the wall. It briefly did: the multi-links
 * work (664c50a) pointed this count at `countActiveShareLinks`, and a workspace holding two
 * documents was told "11 of 3 · At your link limit". The cap was always on documents and the gates
 * were always on creating or sharing one; only the counting drifted.
 */
export const FREE_DOCUMENTS = 3;
/** Free plan: non-request projects. */
export const FREE_PROJECTS = 1;
/** Free plan: viewer analytics window in days. */
export const FREE_ANALYTICS_DAYS = 7;
/** Pro plan: collaborators (members beyond the owner) included in the base price. */
export const PRO_INCLUDED_COLLABORATORS = 1;
/** Days a grandfathered workspace may stay over a Free limit before it is blocked. */
export const LIMIT_GRACE_DAYS = 14;

export type PlanId = "free" | "pro";

/** Per-plan caps; `null` means unlimited. `collaborators` = members allowed beyond the owner. */
export type PlanLimits = {
  plan: PlanId;
  documents: number | null;
  projects: number | null;
  analyticsDays: number | null;
  collaborators: number;
};

/**
 * What `checkLimit` can enforce. The first three are counts against a cap; `version_history` and
 * `analytics_history` are Pro feature gates (blocked on Free regardless of usage, never subject to
 * grace).
 */
export type LimitKey = "documents" | "projects" | "collaborators" | "version_history" | "analytics_history";

/** Limits that gate a Pro feature rather than count usage. */
export type FeatureGateKey = Extract<LimitKey, "version_history" | "analytics_history">;

/** Limits that count usage against a cap. */
export type CountedLimitKey = Exclude<LimitKey, FeatureGateKey>;

/** Analytics depth a workspace is entitled to: Free → `"basic"`, Pro → `"deep"`. */
export type AnalyticsTier = "basic" | "deep";

/** True for limits that gate a Pro feature rather than count usage. */
function isFeatureGate(limit: LimitKey): limit is FeatureGateKey {
  return limit === "version_history" || limit === "analytics_history";
}

/** Grace window for a workspace over a Free limit (ISO strings), or `null` when none. */
export type GraceState = { startedAt: string; endsAt: string; blockedAt: string | null } | null;

export type LimitCheck =
  | { ok: true; warning: null | { limit: LimitKey; used: number; max: number; grace: GraceState } }
  | {
      ok: false;
      code: "plan_limit";
      limit: LimitKey;
      used: number;
      max: number;
      grace: GraceState;
      upgradeUrl: "/pricing";
      message: string;
    };

/** Blocked check (the `ok: false` branch of `LimitCheck`). */
export type PlanLimitBlocked = Extract<LimitCheck, { ok: false }>;

/** Path clients send users to when a limit blocks them. */
const UPGRADE_URL = "/pricing" as const;

const PLAN_LIMITS: Record<PlanId, PlanLimits> = {
  free: {
    plan: "free",
    documents: FREE_DOCUMENTS,
    projects: FREE_PROJECTS,
    analyticsDays: FREE_ANALYTICS_DAYS,
    collaborators: 0,
  },
  pro: {
    plan: "pro",
    documents: null,
    projects: null,
    analyticsDays: null,
    collaborators: PRO_INCLUDED_COLLABORATORS,
  },
};

/** Return the caps for a plan. */
export function limitsForPlan(plan: PlanId): PlanLimits {
  return { ...PLAN_LIMITS[plan] };
}

/** Coerce a string/ObjectId org id to an ObjectId; throws on malformed input. */
function toOrgObjectId(orgId: string | Types.ObjectId): Types.ObjectId {
  if (orgId instanceof Types.ObjectId) return orgId;
  const s = String(orgId).trim();
  if (!Types.ObjectId.isValid(s)) throw new Error("Invalid orgId");
  return new Types.ObjectId(s);
}

/** True for Stripe statuses the app treats as paid. */
function isProStatus(statusRaw: unknown): boolean {
  const s = typeof statusRaw === "string" ? statusRaw.trim().toLowerCase() : "";
  return s === "active" || s === "trialing";
}

/**
 * Resolve a workspace's plan from its `Subscription` row.
 *
 * `active`/`trialing` → `"pro"`; anything else (including no row) → `"free"`.
 */
export async function getWorkspacePlan(orgId: string | Types.ObjectId): Promise<PlanId> {
  const id = toOrgObjectId(orgId);
  await connectMongo();
  const sub = await SubscriptionModel.findOne({ orgId: id, isDeleted: { $ne: true } })
    .select({ status: 1 })
    .lean();
  return isProStatus((sub as { status?: unknown } | null)?.status) ? "pro" : "free";
}

/**
 * Count what a workspace is using against its caps (three `countDocuments` calls).
 *
 * - `documents`: docs with sharing enabled, not deleted and not archived. Documents, never share
 *   links: a document may own any number of links and that is the point of the feature, so counting
 *   links here made the headline feature the thing a Free workspace ran out of. See `FREE_DOCUMENTS`.
 * - `projects`: non-request projects, not deleted (request repos are not capped).
 * - `members`: non-deleted memberships, owner included.
 */
export async function getWorkspaceUsage(
  orgId: string | Types.ObjectId,
): Promise<{ documents: number; projects: number; members: number }> {
  const id = toOrgObjectId(orgId);
  await connectMongo();
  const [documents, projects, members] = await Promise.all([
    DocModel.countDocuments({
      orgId: id,
      shareEnabled: { $ne: false },
      isDeleted: { $ne: true },
      isArchived: { $ne: true },
    }),
    ProjectModel.countDocuments({
      orgId: id,
      isDeleted: { $ne: true },
      isRequest: { $ne: true },
      // `$in: [null, ""]` also matches a missing field.
      requestUploadToken: { $in: [null, ""] },
    }),
    OrgMembershipModel.countDocuments({ orgId: id, isDeleted: { $ne: true } }),
  ]);
  return { documents, projects, members };
}

/** Convert a stored `Org.planGrace` value into the ISO-string `GraceState` shape. */
function graceStateOf(raw: unknown): GraceState {
  if (!raw || typeof raw !== "object") return null;
  const g = raw as { startedAt?: unknown; endsAt?: unknown; blockedAt?: unknown };
  const startedAt = toIso(g.startedAt);
  const endsAt = toIso(g.endsAt);
  if (!startedAt || !endsAt) return null;
  return { startedAt, endsAt, blockedAt: toIso(g.blockedAt) };
}

/** ISO string for a Date or date-like string; null otherwise. */
function toIso(v: unknown): string | null {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (typeof v === "string" && v.trim()) {
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  return null;
}

/** Read the workspace's grace window from `Org.planGrace` (null when none). */
export async function getWorkspaceGrace(orgId: string | Types.ObjectId): Promise<GraceState> {
  const id = toOrgObjectId(orgId);
  await connectMongo();
  const org = await OrgModel.findOne({ _id: id, isDeleted: { $ne: true } })
    .select({ planGrace: 1 })
    .lean();
  return graceStateOf((org as { planGrace?: unknown } | null)?.planGrace);
}

/** Human message for a blocked limit, e.g. "Free workspaces can share 3 documents. Archive one or upgrade to Pro." */
function limitMessage(limit: LimitKey, max: number, plan: PlanId = "free"): string {
  if (plan === "pro" && limit === "collaborators") {
    return `Pro includes ${max} collaborator${max === 1 ? "" : "s"}. Contact us to add more seats to this workspace.`;
  }
  switch (limit) {
    case "documents":
      // "Archive one" rather than "disable a link": the cap counts shared documents, and a link is
      // never the thing to remove — a document may carry a dozen of them by design.
      return `Free workspaces can share ${max} document${max === 1 ? "" : "s"}. Archive one or upgrade to Pro.`;
    case "projects":
      return `Free workspaces can have ${max} project${max === 1 ? "" : "s"}. Delete one or upgrade to Pro.`;
    case "collaborators":
      return max === 0
        ? "Free workspaces are single-user. Upgrade to Pro to invite collaborators."
        : `Free workspaces can have ${max} collaborator${max === 1 ? "" : "s"}. Upgrade to Pro to invite more.`;
    case "version_history":
      return "Letting recipients browse versions is a Pro feature.";
    case "analytics_history":
      return "Deep analytics are a Pro feature.";
  }
}

/**
 * Check whether a workspace may add `opts.adding` (default 1) more of `limit`.
 *
 * Pro → always ok. Free → compares current usage plus the addition against the cap
 * (`collaborators` counts members minus the owner). Over the cap, a workspace inside an
 * unblocked grace window gets `ok: true` with a `warning`; otherwise it gets the blocked shape
 * that `planLimitResponse()` turns into a 402.
 *
 * Feature gates (`version_history`, `analytics_history`) skip counting entirely: Pro → ok, Free →
 * blocked with `used: 0`, `max: 0`, `grace: null` (grace never applies to a gate).
 */
export async function checkLimit(
  orgId: string | Types.ObjectId,
  limit: LimitKey,
  opts?: { adding?: number },
): Promise<LimitCheck> {
  const plan = await getWorkspacePlan(orgId);

  // Feature gates are decided by plan alone: no usage query, no grace window.
  if (isFeatureGate(limit)) {
    if (plan === "pro") return { ok: true, warning: null };
    return {
      ok: false,
      code: "plan_limit",
      limit,
      used: 0,
      max: 0,
      grace: null,
      upgradeUrl: UPGRADE_URL,
      message: limitMessage(limit, 0, plan),
    };
  }

  // Pro is unlimited on links and projects; collaborators are still capped at the included count
  // (additional seats are an in-product upsell), so only that limit is evaluated for Pro.
  if (plan === "pro" && limit !== "collaborators") return { ok: true, warning: null };

  const limits = limitsForPlan(plan);
  const adding = typeof opts?.adding === "number" && Number.isFinite(opts.adding) ? Math.max(0, Math.floor(opts.adding)) : 1;
  const usage = await getWorkspaceUsage(orgId);

  let current: number;
  let max: number;
  switch (limit) {
    case "documents":
      current = usage.documents;
      max = limits.documents ?? Number.POSITIVE_INFINITY;
      break;
    case "projects":
      current = usage.projects;
      max = limits.projects ?? Number.POSITIVE_INFINITY;
      break;
    case "collaborators":
      current = Math.max(0, usage.members - 1);
      max = limits.collaborators;
      break;
  }

  const used = current + adding;
  if (used <= max) return { ok: true, warning: null };

  // Grace windows exist only for Free workspaces that were over the caps at launch.
  const grace = plan === "free" ? await getWorkspaceGrace(orgId) : null;
  const inGrace = Boolean(grace && !grace.blockedAt && Date.now() < new Date(grace.endsAt).getTime());
  if (inGrace) return { ok: true, warning: { limit, used, max, grace } };

  return {
    ok: false,
    code: "plan_limit",
    limit,
    used,
    max,
    grace,
    upgradeUrl: UPGRADE_URL,
    message: limitMessage(limit, max, plan),
  };
}

/**
 * Turn a blocked `checkLimit()` result into a `402` JSON response.
 *
 * Body: `{ error, code: "plan_limit", limit, used, max, grace, upgradeUrl, message }` — `error`
 * mirrors `message` so generic error handling still shows something sensible.
 */
export function planLimitResponse(check: PlanLimitBlocked): NextResponse {
  return NextResponse.json(
    { error: check.message, ...check },
    { status: 402, headers: { "cache-control": "no-store" } },
  );
}

/**
 * Analytics depth for a plan: Free → `"basic"` (totals, series, total time, viewer count only),
 * Pro → `"deep"` (viewer identities, per-viewer rows, per-page time, visit timelines).
 */
export function analyticsTierForPlan(plan: PlanId): AnalyticsTier {
  return plan === "pro" ? "deep" : "basic";
}

/** Clamp a requested analytics window to the plan's cap (Free → at most `FREE_ANALYTICS_DAYS`). */
export function clampAnalyticsDays(plan: PlanId, requestedDays: number): number {
  const requested = Number.isFinite(requestedDays) ? Math.max(1, Math.floor(requestedDays)) : 1;
  const cap = limitsForPlan(plan).analyticsDays;
  return cap === null ? requested : Math.min(requested, cap);
}
