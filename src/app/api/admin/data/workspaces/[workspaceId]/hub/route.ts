/**
 * Admin API route: `GET /api/admin/data/workspaces/:workspaceId/hub`
 *
 * Everything support needs about one workspace in a single read: identity, plan and Stripe state,
 * the credit balance and recent ledger, the API keys agents connect with, content totals, and the
 * tail of the activity feed. Before this existed the answers were spread over Mongo shells and a
 * global credits tool you pasted an id into.
 *
 * Strictly read-only. In particular it reads `WorkspaceCreditBalance` directly instead of calling
 * `getCreditsSnapshot`, which upserts a balance row (seeding 50 starter credits and the daily cap)
 * as a side effect — inspecting a workspace must not change it. The cost is that a workspace that
 * has never run anything shows em dashes rather than its would-be starter balance.
 *
 * Every query is bounded and hits an index prefix; the list tails are capped at 20 rows.
 */
import { NextResponse } from "next/server";
import { Types } from "mongoose";

import { connectMongo } from "@/lib/mongodb";
import { requireAdmin } from "@/lib/gating/requireAdmin";
import { OrgModel } from "@/lib/models/Org";
import { OrgMembershipModel } from "@/lib/models/OrgMembership";
import { UserModel } from "@/lib/models/User";
import { SubscriptionModel } from "@/lib/models/Subscription";
import { WorkspaceCreditBalanceModel } from "@/lib/models/WorkspaceCreditBalance";
import { CreditLedgerModel } from "@/lib/models/CreditLedger";
import { ApiKeyModel } from "@/lib/models/ApiKey";
import { ActivityEventModel } from "@/lib/models/ActivityEvent";
import { DocModel } from "@/lib/models/Doc";
import { ShareViewModel } from "@/lib/models/ShareView";
import { DOC_LINK_FILTER, PROJECT_LINK_FILTER, ShareLinkModel } from "@/lib/models/ShareLink";
import { getWorkspaceUsage, limitsForPlan } from "@/lib/billing/planLimits";
import { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE } from "@/lib/credits/grants";
import { isProSubscription } from "@/lib/billing/subscriptionState";
import type {
  WorkspaceActivityRowDTO,
  WorkspaceApiKeyDTO,
  WorkspaceBalanceDTO,
  WorkspaceGraceDTO,
  WorkspaceLedgerRowDTO,
  WorkspaceLimitsDTO,
  WorkspacePlanDTO,
} from "@/lib/admin/workspaceHub";

export const runtime = "nodejs";

/** How many rows each tail table shows. Small on purpose: this is a triage view, not an export. */
const TAIL_LIMIT = 20;
/** Owners are usually one; cap anyway so a pathological org cannot widen the query. */
const OWNERS_LIMIT = 10;

/** A trimmed non-empty string, or null. */
function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

/** A valid `Date` as ISO, or null. */
function iso(v: unknown): string | null {
  return v instanceof Date && !Number.isNaN(v.valueOf()) ? v.toISOString() : null;
}

/** A finite number, or the fallback — credit columns default to 0. */
function n(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A finite number, or null where null is itself meaningful (an absent cap). */
function nOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** An ObjectId as a string, or null. */
function oid(v: unknown): string | null {
  return v instanceof Types.ObjectId ? String(v) : null;
}

/** The whole hub payload for one workspace. Admin only. */
export async function GET(request: Request, ctx: { params: Promise<{ workspaceId: string }> }) {
  const auth = await requireAdmin(request);
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });

  const { workspaceId: workspaceIdRaw } = await ctx.params;
  const workspaceId = (workspaceIdRaw ?? "").trim();
  if (!Types.ObjectId.isValid(workspaceId)) return NextResponse.json({ error: "Invalid workspaceId" }, { status: 400 });

  await connectMongo();
  const orgId = new Types.ObjectId(workspaceId);

  const org = await OrgModel.findOne({ _id: orgId, isDeleted: { $ne: true } })
    .select({ type: 1, name: 1, slug: 1, createdByUserId: 1, personalForUserId: 1, planGrace: 1, createdDate: 1, updatedDate: 1 })
    .lean();
  if (!org) return NextResponse.json({ error: "Workspace not found" }, { status: 404 });

  const [sub, balanceRow, usage, archivedDocs, totalDocs, docLinks, projectLinks, viewers, keys, ledger, activity, ownerMemberships] =
    await Promise.all([
      SubscriptionModel.findOne({ orgId, isDeleted: { $ne: true } })
        .select({
          status: 1,
          kind: 1,
          planName: 1,
          stripeCustomerId: 1,
          stripeSubscriptionId: 1,
          stripeSubscriptionItemId: 1,
          currentPeriodStart: 1,
          currentPeriodEnd: 1,
          cancelAtPeriodEnd: 1,
        })
        .lean(),
      WorkspaceCreditBalanceModel.findOne({ workspaceId: orgId }).lean(),
      // live documents, projects and members, using the same definitions the plan limits enforce —
      // so "3 of 3 documents" here means exactly what the app blocks on.
      getWorkspaceUsage(orgId),
      DocModel.countDocuments({ orgId, isArchived: true, isDeleted: { $ne: true } }),
      DocModel.countDocuments({ orgId, isDeleted: { $ne: true } }),
      // `DOC_LINK_FILTER`, never `kind: "doc"`: links created before `kind` existed have no such
      // field and would silently drop out of the count.
      ShareLinkModel.countDocuments({ orgId, ...DOC_LINK_FILTER, archivedAt: null }),
      ShareLinkModel.countDocuments({ orgId, ...PROJECT_LINK_FILTER, archivedAt: null }),
      // One row per viewer per link, owner previews excluded. `orgId` is denormalised and is null
      // on rows written before the field existed, so this undercounts until
      // scripts/sharelinks-analytics-backfill.ts has run against the database.
      ShareViewModel.countDocuments({ orgId, isOwnerPreview: { $ne: true } }),
      ApiKeyModel.find({ orgId, isDeleted: { $ne: true } })
        .sort({ createdDate: -1 })
        .limit(TAIL_LIMIT)
        .select({ name: 1, prefix: 1, scopes: 1, lastUsedAt: 1, lastUsedClient: 1, useCount: 1, revokedAt: 1, createdDate: 1 })
        .lean(),
      CreditLedgerModel.find({ workspaceId: orgId })
        .sort({ createdDate: -1 })
        .limit(TAIL_LIMIT)
        .select({
          eventType: 1,
          actionType: 1,
          qualityTier: 1,
          status: 1,
          source: 1,
          creditsEstimated: 1,
          creditsReserved: 1,
          creditsCharged: 1,
          creditsFromTrial: 1,
          creditsFromSubscription: 1,
          creditsFromPurchased: 1,
          creditsFromOnDemand: 1,
          createdDate: 1,
        })
        .lean(),
      ActivityEventModel.find({ orgId })
        .sort({ createdDate: -1 })
        .limit(TAIL_LIMIT)
        .select({ type: 1, title: 1, actorKind: 1, agent: 1, createdDate: 1 })
        .lean(),
      OrgMembershipModel.find({ orgId, role: "owner", isDeleted: { $ne: true } })
        .limit(OWNERS_LIMIT)
        .select({ userId: 1 })
        .lean(),
    ]);

  const ownerIds = ownerMemberships
    .map((m) => (m as { userId?: unknown }).userId)
    .filter((v): v is Types.ObjectId => v instanceof Types.ObjectId);
  const ownerUsers = ownerIds.length
    ? await UserModel.find({ _id: { $in: ownerIds } })
        .limit(OWNERS_LIMIT)
        .select({ email: 1, name: 1 })
        .lean()
    : [];
  const ownerById = new Map(ownerUsers.map((u) => [String(u._id), u]));

  const plan: WorkspacePlanDTO = {
    hasSubscription: Boolean(sub),
    status: str((sub as { status?: unknown } | null)?.status),
    // null means "row predates the field"; the page spells that out rather than guessing "pro".
    kind:
      (sub as { kind?: unknown } | null)?.kind === "pro" || (sub as { kind?: unknown } | null)?.kind === "payg"
        ? ((sub as { kind: "pro" | "payg" }).kind)
        : null,
    planName: str((sub as { planName?: unknown } | null)?.planName),
    stripeCustomerId: str((sub as { stripeCustomerId?: unknown } | null)?.stripeCustomerId),
    stripeSubscriptionId: str((sub as { stripeSubscriptionId?: unknown } | null)?.stripeSubscriptionId),
    stripeSubscriptionItemId: str((sub as { stripeSubscriptionItemId?: unknown } | null)?.stripeSubscriptionItemId),
    currentPeriodStart: iso((sub as { currentPeriodStart?: unknown } | null)?.currentPeriodStart),
    currentPeriodEnd: iso((sub as { currentPeriodEnd?: unknown } | null)?.currentPeriodEnd),
    cancelAtPeriodEnd: Boolean((sub as { cancelAtPeriodEnd?: unknown } | null)?.cancelAtPeriodEnd),
  };

  // Plan, not status: a pay-as-you-go workspace is `active` in Stripe and still Free-capped.
  const planId = isProSubscription({ status: plan.status, kind: plan.kind }) ? "pro" : "free";
  const caps = limitsForPlan(planId);
  const limits: WorkspaceLimitsDTO = {
    plan: planId,
    documents: caps.documents,
    projects: caps.projects,
    collaborators: caps.collaborators,
    analyticsDays: caps.analyticsDays,
  };

  const balance: WorkspaceBalanceDTO = {
    hasRow: Boolean(balanceRow),
    trialCreditsRemaining: nOrNull((balanceRow as { trialCreditsRemaining?: unknown } | null)?.trialCreditsRemaining),
    subscriptionCreditsRemaining: nOrNull(
      (balanceRow as { subscriptionCreditsRemaining?: unknown } | null)?.subscriptionCreditsRemaining,
    ),
    purchasedCreditsRemaining: nOrNull((balanceRow as { purchasedCreditsRemaining?: unknown } | null)?.purchasedCreditsRemaining),
    onDemandEnabled: Boolean((balanceRow as { onDemandEnabled?: unknown } | null)?.onDemandEnabled),
    onDemandMonthlyLimitCents: nOrNull((balanceRow as { onDemandMonthlyLimitCents?: unknown } | null)?.onDemandMonthlyLimitCents),
    // null is a real value here, not a missing one: Pro has no daily cap.
    dailyCreditCap: nOrNull((balanceRow as { dailyCreditCap?: unknown } | null)?.dailyCreditCap),
    monthlyCreditCap: nOrNull((balanceRow as { monthlyCreditCap?: unknown } | null)?.monthlyCreditCap),
    currentPeriodStart: iso((balanceRow as { currentPeriodStart?: unknown } | null)?.currentPeriodStart),
    currentPeriodEnd: iso((balanceRow as { currentPeriodEnd?: unknown } | null)?.currentPeriodEnd),
  };

  const graceRaw = (org as { planGrace?: unknown }).planGrace as
    | { startedAt?: unknown; endsAt?: unknown; blockedAt?: unknown }
    | null
    | undefined;
  const grace: WorkspaceGraceDTO = graceRaw
    ? { startedAt: iso(graceRaw.startedAt), endsAt: iso(graceRaw.endsAt), blockedAt: iso(graceRaw.blockedAt) }
    : null;

  const ledgerRows: WorkspaceLedgerRowDTO[] = ledger.map((r) => ({
    id: String(r._id),
    createdDate: iso((r as { createdDate?: unknown }).createdDate),
    eventType: str((r as { eventType?: unknown }).eventType),
    actionType: str((r as { actionType?: unknown }).actionType),
    qualityTier: str((r as { qualityTier?: unknown }).qualityTier),
    status: str((r as { status?: unknown }).status),
    source: str((r as { source?: unknown }).source),
    creditsEstimated: n((r as { creditsEstimated?: unknown }).creditsEstimated),
    creditsReserved: n((r as { creditsReserved?: unknown }).creditsReserved),
    creditsCharged: n((r as { creditsCharged?: unknown }).creditsCharged),
    creditsFromTrial: n((r as { creditsFromTrial?: unknown }).creditsFromTrial),
    creditsFromSubscription: n((r as { creditsFromSubscription?: unknown }).creditsFromSubscription),
    creditsFromPurchased: n((r as { creditsFromPurchased?: unknown }).creditsFromPurchased),
    creditsFromOnDemand: n((r as { creditsFromOnDemand?: unknown }).creditsFromOnDemand),
  }));

  const apiKeys: WorkspaceApiKeyDTO[] = keys.map((k) => {
    const scopes = (k as { scopes?: unknown }).scopes;
    return {
      id: String(k._id),
      name: str((k as { name?: unknown }).name),
      // `prefix` is the first 12 characters and is safe to show; `keyHash` is never selected.
      prefix: str((k as { prefix?: unknown }).prefix),
      scopes: Array.isArray(scopes) ? scopes.filter((s): s is string => typeof s === "string") : [],
      createdDate: iso((k as { createdDate?: unknown }).createdDate),
      lastUsedAt: iso((k as { lastUsedAt?: unknown }).lastUsedAt),
      lastUsedClient: str((k as { lastUsedClient?: unknown }).lastUsedClient),
      useCount: n((k as { useCount?: unknown }).useCount),
      revokedAt: iso((k as { revokedAt?: unknown }).revokedAt),
    };
  });

  const activityRows: WorkspaceActivityRowDTO[] = activity.map((a) => {
    const agent = (a as { agent?: unknown }).agent as { client?: unknown } | null | undefined;
    return {
      id: String(a._id),
      type: str((a as { type?: unknown }).type),
      title: str((a as { title?: unknown }).title),
      createdDate: iso((a as { createdDate?: unknown }).createdDate),
      actorKind: str((a as { actorKind?: unknown }).actorKind),
      agentClient: agent ? str(agent.client) : null,
    };
  });

  return NextResponse.json({
    ok: true,
    workspaceId,
    workspace: {
      id: workspaceId,
      type: str((org as { type?: unknown }).type),
      name: str((org as { name?: unknown }).name),
      slug: str((org as { slug?: unknown }).slug),
      createdDate: iso((org as { createdDate?: unknown }).createdDate),
      updatedDate: iso((org as { updatedDate?: unknown }).updatedDate),
      createdByUserId: oid((org as { createdByUserId?: unknown }).createdByUserId),
      personalForUserId: oid((org as { personalForUserId?: unknown }).personalForUserId),
    },
    owners: ownerIds.map((id) => {
      const u = ownerById.get(String(id)) ?? null;
      return {
        userId: String(id),
        email: u ? str((u as { email?: unknown }).email) : null,
        name: u ? str((u as { name?: unknown }).name) : null,
      };
    }),
    plan,
    limits,
    // The grants the credit columns are read against, so the page never spells a number out.
    creditRules: { starterGrant: FREE_STARTER_CREDITS, includedPerCycle: INCLUDED_CREDITS_PER_CYCLE },
    grace,
    balance,
    content: {
      liveDocs: usage.documents,
      archivedDocs,
      totalDocs,
      projects: usage.projects,
      members: usage.members,
      docLinks,
      projectLinks,
      viewers,
    },
    ledger: ledgerRows,
    apiKeys,
    activity: activityRows,
  });
}
