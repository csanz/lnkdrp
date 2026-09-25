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
import { isProSubscription } from "@/lib/billing/subscriptionState";
import { recordActivity, type ActivityActorKind } from "@/lib/activity/log";
import { liveProjectFilter } from "@/lib/projects/scope";
// The cap counts shared documents directly through `DocModel` below. It used to import the
// share-links service to count links instead — the drift that made two documents read "11 of 3"
// — and this comment described that import as the thing keeping the cap honest. It was the thing
// making it wrong.

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
export const FREE_DOCUMENTS = 10;
/** Free plan: non-request projects. */
export const FREE_PROJECTS = 2;
/** Free plan: viewer analytics window in days. */
export const FREE_ANALYTICS_DAYS = 7;
/**
 * Pro: people beyond the owner who can *do* things, included in the base price.
 *
 * Three, because the set of people who upload and share is small — a founder, a co-founder, a head
 * of sales — while the set who want to read the numbers is not. Only the first group takes a seat:
 * a `viewer` membership is free and uncapped (see `getWorkspaceUsage`), which is what lets this be
 * three rather than a number that has to keep rising.
 *
 * It was 1, and it was a wall: a third person got "Contact us to add more seats" and had to email
 * us to use a product they had already paid for.
 */
export const PRO_INCLUDED_COLLABORATORS = 3;
/**
 * Free plan: team workspaces one person may own (their personal workspace is always theirs and is
 * never counted).
 *
 * Every other cap here is per workspace, and creating a workspace was free and unlimited — so three
 * shared documents was only ever three *per workspace*, and a second workspace reset the counter.
 * This is the limit that makes the others mean what they say.
 */
export const FREE_TEAM_WORKSPACES = 1;
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
 * What `checkLimit` can enforce. The first three are counts against a cap; `version_history`,
 * `analytics_history` and `project_links` are Pro feature gates (blocked on Free regardless of
 * usage, never subject to grace).
 */
export type LimitKey =
  | "documents"
  | "projects"
  | "collaborators"
  | "version_history"
  | "analytics_history"
  | "project_links"
  | "team_workspaces";

/** Limits that gate a Pro feature rather than count usage. */
export type FeatureGateKey = Extract<LimitKey, "version_history" | "analytics_history" | "project_links">;

/** Limits that count usage against a cap. */
export type CountedLimitKey = Exclude<LimitKey, FeatureGateKey>;

/** Analytics depth a workspace is entitled to: Free → `"basic"`, Pro → `"deep"`. */
export type AnalyticsTier = "basic" | "deep";

/** True for limits that gate a Pro feature rather than count usage. */
function isFeatureGate(limit: LimitKey): limit is FeatureGateKey {
  return limit === "version_history" || limit === "analytics_history" || limit === "project_links";
}

/** Grace window for a workspace over a Free limit (ISO strings), or `null` when none. */
export type GraceState = { startedAt: string; endsAt: string; blockedAt: string | null } | null;

/**
 * `used` is what the workspace HOLDS, not what the refused write would have taken it to.
 *
 * It used to be `current + adding`, and every caller passes it on under that name: the 402 body,
 * the `plan.limit_reached` activity row, the web upgrade notice (`planLimitUsageSuffix` renders
 * "{used} of {max} used.") and the MCP's own planWarning sentence. So a Free workspace holding two
 * projects was refused a third with `used: 3, max: 2` — a state it had never been in, written into
 * its permanent history, and shown to the owner as "3 of 2 used." while `GET /api/plan` answered
 * `used: 2` in the same minute. `CreateProjectModal` even falls back to the plan route's true count
 * when it has no error to read, so the number on screen moved by one depending on which source
 * answered.
 *
 * `requested` carries what was asked for, which is the part a bulk add needs: 8 of 10 used, 5
 * requested, is a refusal a caller can act on. `wouldBe` is kept off the type on purpose — it is
 * `used + requested` and a third number invites a fourth reading.
 */
export type LimitOverage = { limit: LimitKey; used: number; requested: number; max: number; grace: GraceState };

export type LimitCheck =
  | { ok: true; warning: null | LimitOverage }
  | ({
      ok: false;
      code: "plan_limit";
      upgradeUrl: "/pricing";
      message: string;
    } & LimitOverage);

/** Blocked check (the `ok: false` branch of `LimitCheck`). */
export type PlanLimitBlocked = Extract<LimitCheck, { ok: false }>;

/** Path clients send users to when a limit blocks them. */
export const UPGRADE_URL = "/pricing" as const;

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

/**
 * Resolve a workspace's plan from its `Subscription` row.
 *
 * Pro means a billable subscription carrying the Pro price. A pay-as-you-go subscription is
 * `active` too but is still `"free"` here: the card buys credits, not limits.
 */
export async function getWorkspacePlan(orgId: string | Types.ObjectId): Promise<PlanId> {
  const id = toOrgObjectId(orgId);
  await connectMongo();
  const sub = await SubscriptionModel.findOne({ orgId: id, isDeleted: { $ne: true } })
    .select({ status: 1, kind: 1 })
    .lean();
  return isProSubscription(sub as { status?: unknown; kind?: unknown } | null) ? "pro" : "free";
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
    // Same filter the project list uses (src/lib/projects/scope.ts): the cap must never count a
    // project the owner cannot see in their list.
    ProjectModel.countDocuments(liveProjectFilter(id)),
    /**
     * Seats count people who can *act*, not everyone with a login.
     *
     * A `viewer` reaches activity, the plan and agent status and nothing that writes (every
     * mutating route gates at `member` or `admin`), so charging for one would be charging to read
     * your own numbers. Counting every membership is what made "Pro includes 1 collaborator" feel
     * hostile: inviting the exec team to look at analytics consumed the seat the co-founder needed.
     */
    OrgMembershipModel.countDocuments({ orgId: id, isDeleted: { $ne: true }, role: { $ne: "viewer" } }),
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
    return `Pro includes ${max} ${max === 1 ? "person" : "people"} beyond the owner. Invite anyone else as a viewer: viewers are free and unlimited, and can see every document and all the analytics.`;
  }
  switch (limit) {
    case "documents":
      // "Archive one" rather than "disable a link": the cap counts shared documents, and a link is
      // never the thing to remove — a document may carry a dozen of them by design.
      return `Free workspaces can share ${max} document${max === 1 ? "" : "s"}. Archive one or upgrade to Pro.`;
    case "projects":
      return `Free workspaces can have ${max} project${max === 1 ? "" : "s"}. Delete one or upgrade to Pro.`;
    case "team_workspaces":
      return max === 1
        ? "Free accounts can have one team workspace. Upgrade to Pro to create another."
        : `Free accounts can have ${max} team workspaces. Upgrade to Pro to create another.`;
    case "collaborators":
      return max === 0
        ? `Free workspaces are single-user. Pro includes ${PRO_INCLUDED_COLLABORATORS} people beyond the owner, plus unlimited free viewers.`
        : `Free workspaces can have ${max} collaborator${max === 1 ? "" : "s"}. Upgrade to Pro to invite more.`;
    case "version_history":
      return "Letting recipients browse versions is a Pro feature.";
    case "analytics_history":
      return "Deep analytics are a Pro feature.";
    case "project_links":
      // A gate, not a cap: Free keeps the project's own default link (materialised from
      // `Project.shareId`, so every `/p/:shareId` in the wild keeps resolving) and is refused only
      // when it tries to add a *second* one. Hence "another link" rather than a number.
      return "Sending a project to more than one audience is a Pro feature.";
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
 * blocked with `used: 0`, `requested: 0`, `max: 0`, `grace: null` (grace never applies to a gate,
 * and there is nothing countable to request).
 */
export async function checkLimit(
  orgId: string | Types.ObjectId,
  limit: LimitKey,
  opts?: {
    adding?: number;
    /**
     * The role being added, when that changes the answer.
     *
     * Only `collaborators` cares, and only about `viewer`. `getWorkspaceUsage` stopped counting
     * viewers when Pro moved to three seats, but the *check* still had no idea what was being
     * invited — so a workspace with three collaborators was refused a viewer invitation, while
     * every screen promised viewers were free and unlimited. The count and the gate have to agree
     * about what a seat is.
     */
    role?: string | null;
  },
): Promise<LimitCheck> {
  // A viewer takes no seat, so there is nothing to check: it is read-only (every mutating route
  // gates above `viewer`) and `getWorkspaceUsage` does not count it.
  if (limit === "collaborators" && (opts?.role ?? "").trim().toLowerCase() === "viewer") {
    return { ok: true, warning: null };
  }

  const plan = await getWorkspacePlan(orgId);

  // Feature gates are decided by plan alone: no usage query, no grace window.
  if (isFeatureGate(limit)) {
    if (plan === "pro") return { ok: true, warning: null };
    return {
      ok: false,
      code: "plan_limit",
      limit,
      used: 0,
      requested: 0,
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
    case "team_workspaces":
      /**
       * Counted per person, not per workspace, so this function — which is handed one workspace —
       * is the wrong place to answer it. `POST /api/orgs` counts the team workspaces the caller
       * owns and builds the same 402 from `FREE_TEAM_WORKSPACES` and `limitMessage` directly.
       * Returning "ok" here would be a lie, so the key is refused instead.
       */
      throw new Error("checkLimit: team_workspaces is a per-user limit; see POST /api/orgs");
  }

  // The comparison is still about where the write would land; only the reporting is about now.
  if (current + adding <= max) return { ok: true, warning: null };

  // Grace windows exist only for Free workspaces that were over the caps at launch.
  const grace = plan === "free" ? await getWorkspaceGrace(orgId) : null;
  const inGrace = Boolean(grace && !grace.blockedAt && Date.now() < new Date(grace.endsAt).getTime());
  if (inGrace) return { ok: true, warning: { limit, used: current, requested: adding, max, grace } };

  return {
    ok: false,
    code: "plan_limit",
    limit,
    used: current,
    requested: adding,
    max,
    grace,
    upgradeUrl: UPGRADE_URL,
    message: limitMessage(limit, max, plan),
  };
}

/**
 * Who hit the wall, for the `plan.limit_reached` row `planLimitResponse` writes.
 *
 * Every 402 is a funnel step (docs/reviews/pricing-upsell-fix-plan-2026-09-23.md, Phase 4.1), and
 * before this eight routes wrote the row by hand while the feature gates (version history, deep
 * analytics, project links) wrote nothing, so the funnel started at the counted caps only.
 */
export type PlanLimitHitContext = {
  orgId: string | Types.ObjectId;
  userId?: string | Types.ObjectId | null;
  /** Defaults to `"user"`. */
  actorKind?: ActivityActorKind;
  request?: Request | null;
  docId?: string | Types.ObjectId | null;
  projectId?: string | Types.ObjectId | null;
  /** Extra `meta` fields (`via`, ...); the limit's own fields win. */
  meta?: Record<string, unknown>;
};

/**
 * How long one workspace's repeat hits on the same limit are folded into one row.
 *
 * The feature gates sit on read routes (a Free metrics page asks for visit timelines on every load),
 * so without this the feed would fill with the same refusal. Per process and best-effort: two
 * instances may each write one row inside the window, and a restart forgets the window. Good
 * enough for a funnel that counts workspaces, not rows.
 */
export const LIMIT_HIT_DEDUPE_MS = 10 * 60 * 1000;

const recentLimitHits = new Map<string, number>();

/** Forget the dedupe window (tests). */
export function resetLimitHitDedupeForTests(): void {
  recentLimitHits.clear();
}

/** True once per `orgId` + `limit` per `LIMIT_HIT_DEDUPE_MS`. */
function shouldRecordLimitHit(orgId: string, limit: LimitKey, now: number): boolean {
  const key = `${orgId}:${limit}`;
  const last = recentLimitHits.get(key);
  if (typeof last === "number" && now - last < LIMIT_HIT_DEDUPE_MS) return false;
  recentLimitHits.set(key, now);
  // Keep the map from growing with every workspace that ever hit a wall.
  if (recentLimitHits.size > 5000) {
    for (const [k, at] of recentLimitHits) if (now - at >= LIMIT_HIT_DEDUPE_MS) recentLimitHits.delete(k);
  }
  return true;
}

/**
 * Turn a blocked `checkLimit()` result into a `402` JSON response.
 *
 * Body: `{ error, code: "plan_limit", limit, used, max, grace, upgradeUrl, message }` — `error`
 * mirrors `message` so generic error handling still shows something sensible.
 *
 * With `hit`, also records a `plan.limit_reached` activity row (`meta: { limit, used, max,
 * grace }`, `grace` being whether a launch grace window was open) once per workspace and limit per
 * `LIMIT_HIT_DEDUPE_MS`. Fire-and-forget: a failed write never changes the response.
 */
export function planLimitResponse(check: PlanLimitBlocked, hit?: PlanLimitHitContext): NextResponse {
  if (hit) {
    const orgId = String(hit.orgId);
    if (shouldRecordLimitHit(orgId, check.limit, Date.now())) {
      void recordActivity({
        orgId: hit.orgId,
        userId: hit.userId ?? null,
        actorKind: hit.actorKind ?? "user",
        type: "plan.limit_reached",
        docId: hit.docId ?? null,
        projectId: hit.projectId ?? null,
        meta: { ...(hit.meta ?? {}), limit: check.limit, used: check.used, max: check.max, grace: check.grace !== null },
        request: hit.request ?? null,
      });
    }
  }
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
