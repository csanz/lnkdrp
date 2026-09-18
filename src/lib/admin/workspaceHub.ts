/**
 * Shaping for the admin workspace hub (`/a/data/workspaces/:workspaceId`).
 *
 * The route reads Mongo and the page renders; everything in between — what "Pro" means once
 * pay-as-you-go exists, which bucket paid for a run, whether a number is a cap or unlimited —
 * lives here so it is the same on both sides and can be tested without a database.
 *
 * Pure and client-safe: no mongoose, no fetch, no `Date.now()` without an argument.
 */
import { creditsShown, type CreditBasis } from "@/lib/admin/creditsAdmin";
import {
  isBillableStatus,
  isPaygSubscription,
  isProSubscription,
  subscriptionKind,
  type SubscriptionKind,
} from "@/lib/billing/subscriptionState";

/** Plan and Stripe state for one workspace, as the route serialises it. */
export type WorkspacePlanDTO = {
  /** true when the workspace has a `Subscription` row at all; a Free workspace often has none. */
  hasSubscription: boolean;
  status: string | null;
  kind: SubscriptionKind | null;
  planName: string | null;
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  stripeSubscriptionItemId: string | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
};

/** The stored credit balance row, or nulls when the workspace has never had one. */
export type WorkspaceBalanceDTO = {
  hasRow: boolean;
  trialCreditsRemaining: number | null;
  subscriptionCreditsRemaining: number | null;
  purchasedCreditsRemaining: number | null;
  onDemandEnabled: boolean;
  onDemandMonthlyLimitCents: number | null;
  dailyCreditCap: number | null;
  monthlyCreditCap: number | null;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
};

/** One `CreditLedger` row, trimmed to what the hub shows. */
export type WorkspaceLedgerRowDTO = {
  id: string;
  createdDate: string | null;
  eventType: string | null;
  actionType: string | null;
  qualityTier: string | null;
  status: string | null;
  source: string | null;
  creditsEstimated: number;
  creditsReserved: number;
  creditsCharged: number;
  creditsFromTrial: number;
  creditsFromSubscription: number;
  creditsFromPurchased: number;
  creditsFromOnDemand: number;
};

/** One API key. `keyHash` is deliberately absent: it never leaves the database. */
export type WorkspaceApiKeyDTO = {
  id: string;
  name: string | null;
  prefix: string | null;
  scopes: string[];
  createdDate: string | null;
  lastUsedAt: string | null;
  lastUsedClient: string | null;
  useCount: number;
  revokedAt: string | null;
};

/** One activity event, denormalised at write time so it renders with no joins. */
export type WorkspaceActivityRowDTO = {
  id: string;
  type: string | null;
  title: string | null;
  createdDate: string | null;
  actorKind: string | null;
  agentClient: string | null;
};

export type WorkspaceGraceDTO = { startedAt: string | null; endsAt: string | null; blockedAt: string | null } | null;

/** Content totals. Every one is a real `countDocuments`; see the route for the exact filters. */
export type WorkspaceContentDTO = {
  liveDocs: number;
  archivedDocs: number;
  totalDocs: number;
  projects: number;
  members: number;
  docLinks: number;
  projectLinks: number;
  /** Distinct viewer-per-link rows, owner previews excluded. Not a raw hit count. */
  viewers: number;
};

/**
 * The caps this workspace's plan enforces, resolved server-side. `null` means unlimited; the page
 * cannot compute these itself because `planLimits.ts` reaches into Mongo and is not client-safe.
 */
export type WorkspaceLimitsDTO = {
  plan: "free" | "pro";
  documents: number | null;
  projects: number | null;
  /** Members allowed beyond the owner. */
  collaborators: number;
  analyticsDays: number | null;
};

/**
 * The credit grants in force, resolved server-side from the constants the product enforces.
 *
 * Sent rather than written into the page's labels: the starter grant and the cycle grant are
 * tuning knobs, and a label that spells one out goes quietly wrong the day it is changed.
 */
export type WorkspaceCreditRulesDTO = {
  /** `FREE_STARTER_CREDITS`: the one-time grant every non-Pro workspace gets. */
  starterGrant: number;
  /** `INCLUDED_CREDITS_PER_CYCLE`: Pro's monthly included credits, no rollover. */
  includedPerCycle: number;
};

/** The whole payload of `GET /api/admin/data/workspaces/:id/hub`. */
export type WorkspaceHubDTO = {
  workspaceId: string;
  workspace: {
    id: string;
    type: string | null;
    name: string | null;
    slug: string | null;
    createdDate: string | null;
    updatedDate: string | null;
    createdByUserId: string | null;
    personalForUserId: string | null;
  };
  owners: { userId: string; email: string | null; name: string | null }[];
  plan: WorkspacePlanDTO;
  limits: WorkspaceLimitsDTO;
  creditRules: WorkspaceCreditRulesDTO;
  grace: WorkspaceGraceDTO;
  balance: WorkspaceBalanceDTO;
  content: WorkspaceContentDTO;
  ledger: WorkspaceLedgerRowDTO[];
  apiKeys: WorkspaceApiKeyDTO[];
  activity: WorkspaceActivityRowDTO[];
};

/**
 * What to call this workspace's plan.
 *
 * `status` alone cannot answer it: a Free workspace that adds a card gets an `active` Stripe
 * subscription carrying only the metered credits price. Pro and pay-as-you-go must read
 * differently or support will treat one as the other.
 */
export function planLabel(plan: WorkspacePlanDTO | null | undefined): string {
  if (!plan || !plan.hasSubscription) return "Free";
  const sub = { status: plan.status, kind: plan.kind };
  if (isProSubscription(sub)) return "Pro";
  if (isPaygSubscription(sub)) return "Free (pay-as-you-go)";
  // A row exists but is not billable — cancelled, past_due, incomplete. The workspace is Free
  // today, and the status beside this label says why.
  return "Free";
}

/** True when this workspace is entitled to Pro limits and the 300 included credits a cycle. */
export function isProPlan(plan: WorkspacePlanDTO | null | undefined): boolean {
  if (!plan || !plan.hasSubscription) return false;
  return isProSubscription({ status: plan.status, kind: plan.kind });
}

/** The `kind` column, spelled out. Legacy rows have no `kind` and read as Pro. */
export function kindLabel(plan: WorkspacePlanDTO | null | undefined): string {
  if (!plan || !plan.hasSubscription) return "—";
  if (plan.kind === null) return "pro (legacy, no kind stored)";
  return subscriptionKind({ status: plan.status, kind: plan.kind });
}

/**
 * The cancellation cell. `periodEndLabel` is already-formatted text from the caller, because
 * date formatting is the page's job and this module stays free of locales.
 */
export function cancelText(cancelAtPeriodEnd: boolean, periodEndLabel: string): string {
  if (!cancelAtPeriodEnd) return "No";
  const end = periodEndLabel.trim();
  return end ? `Yes — ends ${end}` : "Yes — end date unknown";
}

/** Whether Stripe may charge this workspace at all, either kind. */
export function billableLabel(plan: WorkspacePlanDTO | null | undefined): string {
  if (!plan || !plan.hasSubscription) return "No";
  return isBillableStatus(plan.status) ? "Yes" : "No";
}

export type CreditSummary = {
  hasRow: boolean;
  /** The one-time starter grant every non-Pro workspace gets. `trialCreditsRemaining` is its historical name. */
  starter: number | null;
  /** Pro's monthly included credits. */
  included: number | null;
  purchased: number | null;
  /** starter + included + purchased, or null when there is no balance row to add up. */
  total: number | null;
  dailyCap: number | null;
  monthlyCap: number | null;
  /** The stored toggle, which on a non-Pro workspace is ignored at spend time. */
  onDemandStored: boolean;
  /** The toggle as it actually behaves: on-demand is Pro-only. */
  onDemandEligible: boolean;
  onDemandMonthlyLimitCents: number | null;
};

/**
 * Fold the balance row into what the page shows.
 *
 * `onDemandEligible` is not the stored flag: the credits snapshot forces on-demand off for any
 * workspace that is not Pro, so a legacy payg row with the toggle on still cannot spend. Showing
 * the stored value alone would have support promising credits that will never be granted.
 */
export function creditSummary(params: {
  balance: WorkspaceBalanceDTO | null | undefined;
  isPro: boolean;
}): CreditSummary {
  const b = params.balance;
  if (!b || !b.hasRow) {
    return {
      hasRow: false,
      starter: null,
      included: null,
      purchased: null,
      total: null,
      dailyCap: null,
      monthlyCap: null,
      onDemandStored: false,
      onDemandEligible: false,
      onDemandMonthlyLimitCents: null,
    };
  }
  const starter = num(b.trialCreditsRemaining);
  const included = num(b.subscriptionCreditsRemaining);
  const purchased = num(b.purchasedCreditsRemaining);
  return {
    hasRow: true,
    starter,
    included,
    purchased,
    total: (starter ?? 0) + (included ?? 0) + (purchased ?? 0),
    dailyCap: num(b.dailyCreditCap),
    monthlyCap: num(b.monthlyCreditCap),
    onDemandStored: Boolean(b.onDemandEnabled),
    onDemandEligible: Boolean(b.onDemandEnabled) && params.isPro,
    onDemandMonthlyLimitCents: num(b.onDemandMonthlyLimitCents),
  };
}

/**
 * The credits number that matters for a ledger row, and which column it came from. A pending row
 * has only a reservation; a charged row has the real figure; a failed row may have neither.
 *
 * Delegates to `creditsShown` so this hub and the fleet ledger on `/a/credits` read a pending row
 * the same way.
 */
export function ledgerCredits(row: WorkspaceLedgerRowDTO): { value: number; basis: CreditBasis } {
  return creditsShown(row);
}

/**
 * Which bucket paid, in spend order (subscription → starter → purchased → on-demand). A run can
 * straddle two buckets, so this joins them rather than picking a winner.
 */
export function ledgerBucketLabel(row: WorkspaceLedgerRowDTO): string {
  const parts: string[] = [];
  if (row.creditsFromSubscription > 0) parts.push(`included ${row.creditsFromSubscription}`);
  if (row.creditsFromTrial > 0) parts.push(`starter ${row.creditsFromTrial}`);
  if (row.creditsFromPurchased > 0) parts.push(`purchased ${row.creditsFromPurchased}`);
  if (row.creditsFromOnDemand > 0) parts.push(`on-demand ${row.creditsFromOnDemand}`);
  return parts.length ? parts.join(" + ") : "—";
}

/**
 * The buckets that paid, named but not counted: `included`, `included + starter`.
 *
 * The ledger table already carries the figure in its own right-aligned Credits column, so
 * repeating it here made every row state the same number twice ("1 charged" beside
 * "included 1"). `ledgerBucketLabel` keeps the counted form for the `title`, where the
 * split between two buckets is the whole point.
 */
export function ledgerBucketNames(row: WorkspaceLedgerRowDTO): string {
  const parts: string[] = [];
  if (row.creditsFromSubscription > 0) parts.push("included");
  if (row.creditsFromTrial > 0) parts.push("starter");
  if (row.creditsFromPurchased > 0) parts.push("purchased");
  if (row.creditsFromOnDemand > 0) parts.push("on-demand");
  return parts.length ? parts.join(" + ") : "—";
}

export type GraceState = { state: "none" | "active" | "blocked"; daysLeft: number | null };

/**
 * Where a workspace sits in the 14-day plan-limit grace window. `daysLeft` is rounded up, so the
 * last partial day still reads as "1 day left" rather than "0".
 */
export function graceState(grace: WorkspaceGraceDTO, now: Date): GraceState {
  if (!grace || !grace.startedAt || !grace.endsAt) return { state: "none", daysLeft: null };
  if (grace.blockedAt) return { state: "blocked", daysLeft: 0 };
  const ends = new Date(grace.endsAt).valueOf();
  if (!Number.isFinite(ends)) return { state: "active", daysLeft: null };
  const ms = ends - now.valueOf();
  return { state: "active", daysLeft: Math.max(0, Math.ceil(ms / 86_400_000)) };
}

/** `3 / 3` against a plan cap, or plain `12` when the plan has no cap. `over` drives the warning colour. */
export function usageVsLimit(used: number, limit: number | null): { text: string; over: boolean } {
  if (!Number.isFinite(used)) return { text: "—", over: false };
  if (limit === null || !Number.isFinite(limit)) return { text: fmtCount(used), over: false };
  return { text: `${fmtCount(used)} / ${fmtCount(limit)}`, over: used > limit };
}

/** A count, or an em dash when the number never arrived. Never renders blank. */
export function fmtCount(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n)) return "—";
  return n.toLocaleString();
}

/** Cents as dollars, for the on-demand spend limit. */
export function fmtCents(cents: number | null | undefined): string {
  if (typeof cents !== "number" || !Number.isFinite(cents)) return "—";
  return `$${(cents / 100).toFixed(2)}`;
}

/** A cap that may legitimately be "no cap" — Pro's daily credit cap is null on purpose. */
export function fmtCap(cap: number | null | undefined): string {
  if (cap === null) return "none";
  return fmtCount(cap);
}

/** Live vs revoked, for the agent keys table. */
export function keyStateLabel(key: WorkspaceApiKeyDTO): "live" | "revoked" {
  return key.revokedAt ? "revoked" : "live";
}

/** A finite number, or null — so an absent cap stays distinguishable from a cap of zero. */
function num(v: number | null | undefined): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}
