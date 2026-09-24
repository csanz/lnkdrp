/**
 * Shaping for the admin workspace hub (`src/lib/admin/workspaceHub.ts`).
 *
 * The cases that matter are the ones where the obvious reading is wrong: an `active` Stripe
 * subscription that is not Pro, an on-demand toggle that is stored on but cannot spend, a daily
 * cap of `null` that means "no cap" rather than "unknown", and a ledger row that straddles two
 * buckets. Support reads these cells and answers customers from them, so each one is pinned here.
 */
import { describe, expect, test } from "vitest";

import {
  billableLabel,
  cancelText,
  creditSummary,
  fmtCap,
  fmtCents,
  fmtCount,
  graceState,
  isProPlan,
  keyStateLabel,
  kindLabel,
  ledgerBucketLabel,
  ledgerBucketNames,
  ledgerCredits,
  planLabel,
  usageVsLimit,
  type WorkspaceApiKeyDTO,
  type WorkspaceBalanceDTO,
  type WorkspaceLedgerRowDTO,
  type WorkspacePlanDTO,
} from "@/lib/admin/workspaceHub";

/** An active Pro subscription; override one field per case. */
function plan(over: Partial<WorkspacePlanDTO> = {}): WorkspacePlanDTO {
  return {
    hasSubscription: true,
    status: "active",
    kind: "pro",
    planName: "Pro",
    stripeCustomerId: "cus_1",
    stripeSubscriptionId: "sub_1",
    stripeSubscriptionItemId: "si_1",
    currentPeriodStart: "2026-09-01T00:00:00.000Z",
    currentPeriodEnd: "2026-10-01T00:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...over,
  };
}

/** A Free workspace balance: 50 starter credits and the 15/day brake. */
function balance(over: Partial<WorkspaceBalanceDTO> = {}): WorkspaceBalanceDTO {
  return {
    hasRow: true,
    trialCreditsRemaining: 50,
    subscriptionCreditsRemaining: 0,
    purchasedCreditsRemaining: 0,
    onDemandEnabled: false,
    onDemandMonthlyLimitCents: 0,
    dailyCreditCap: 15,
    monthlyCreditCap: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    ...over,
  };
}

/** A charged standard review paid from the starter bucket. */
function ledgerRow(over: Partial<WorkspaceLedgerRowDTO> = {}): WorkspaceLedgerRowDTO {
  return {
    id: "l1",
    createdDate: "2026-09-17T10:00:00.000Z",
    eventType: "ai_run",
    actionType: "review",
    qualityTier: "standard",
    status: "charged",
    source: "owner",
    creditsEstimated: 5,
    creditsReserved: 5,
    creditsCharged: 5,
    creditsFromTrial: 5,
    creditsFromSubscription: 0,
    creditsFromPurchased: 0,
    creditsFromOnDemand: 0,
    ...over,
  };
}

describe("planLabel", () => {
  test("no subscription row is Free", () => {
    expect(planLabel(null)).toBe("Free");
    expect(planLabel(plan({ hasSubscription: false }))).toBe("Free");
  });

  test("active Pro is Pro", () => {
    expect(planLabel(plan())).toBe("Pro");
    expect(isProPlan(plan())).toBe(true);
  });

  test("an active pay-as-you-go row is Free, not Pro", () => {
    const payg = plan({ kind: "payg", planName: "Free" });
    expect(planLabel(payg)).toBe("Free (pay-as-you-go)");
    expect(isProPlan(payg)).toBe(false);
  });

  test("a cancelled Pro row is Free today", () => {
    expect(planLabel(plan({ status: "canceled" }))).toBe("Free");
    expect(isProPlan(plan({ status: "canceled" }))).toBe(false);
  });

  test("trialing counts as Pro", () => {
    expect(planLabel(plan({ status: "trialing" }))).toBe("Pro");
  });

  test("a legacy row with no kind reads as Pro and says so", () => {
    expect(planLabel(plan({ kind: null }))).toBe("Pro");
    expect(kindLabel(plan({ kind: null }))).toBe("pro (legacy, no kind stored)");
    expect(kindLabel(plan({ kind: "payg" }))).toBe("payg");
    expect(kindLabel(null)).toBe("–");
  });
});

describe("billableLabel", () => {
  test("either kind can be charged while active", () => {
    expect(billableLabel(plan({ kind: "payg" }))).toBe("Yes");
    expect(billableLabel(plan())).toBe("Yes");
  });

  test("past_due and no row cannot", () => {
    expect(billableLabel(plan({ status: "past_due" }))).toBe("No");
    expect(billableLabel(null)).toBe("No");
  });
});

describe("cancelText", () => {
  test("names the end date when there is one", () => {
    expect(cancelText(true, "1 Oct 2026")).toBe("Yes, ends 1 Oct 2026");
  });

  test("says the date is unknown rather than trailing off", () => {
    expect(cancelText(true, "")).toBe("Yes, end date unknown");
  });

  test("not cancelling", () => {
    expect(cancelText(false, "1 Oct 2026")).toBe("No");
  });
});

describe("creditSummary", () => {
  test("no balance row gives nulls, not zeroes", () => {
    const s = creditSummary({ balance: null, isPro: false });
    expect(s.hasRow).toBe(false);
    expect(s.total).toBeNull();
    expect(s.starter).toBeNull();
    expect(fmtCount(s.total)).toBe("–");
  });

  test("totals the three buckets", () => {
    const s = creditSummary({
      balance: balance({ trialCreditsRemaining: 12, subscriptionCreditsRemaining: 300, purchasedCreditsRemaining: 30 }),
      isPro: true,
    });
    expect(s.total).toBe(342);
  });

  test("on-demand is Pro-only even when the stored toggle is on", () => {
    const b = balance({ onDemandEnabled: true, onDemandMonthlyLimitCents: 1000 });
    expect(creditSummary({ balance: b, isPro: false }).onDemandEligible).toBe(false);
    expect(creditSummary({ balance: b, isPro: false }).onDemandStored).toBe(true);
    expect(creditSummary({ balance: b, isPro: true }).onDemandEligible).toBe(true);
  });

  test("a null daily cap survives as null — Pro has no cap", () => {
    const s = creditSummary({ balance: balance({ dailyCreditCap: null }), isPro: true });
    expect(s.dailyCap).toBeNull();
    expect(fmtCap(s.dailyCap)).toBe("none");
    expect(fmtCap(15)).toBe("15");
  });
});

describe("ledgerCredits", () => {
  test("a charged row reports what was charged", () => {
    expect(ledgerCredits(ledgerRow())).toEqual({ value: 5, basis: "charged" });
  });

  test("a pending row reports the reservation", () => {
    const r = ledgerRow({ status: "pending", creditsCharged: 0, creditsReserved: 12 });
    expect(ledgerCredits(r)).toEqual({ value: 12, basis: "reserved" });
  });

  test("a failed row with nothing reserved falls back to the estimate", () => {
    const r = ledgerRow({ status: "failed", creditsCharged: 0, creditsReserved: 0, creditsEstimated: 2 });
    expect(ledgerCredits(r)).toEqual({ value: 2, basis: "estimated" });
  });

  test("a charged row worth zero credits still reads as charged", () => {
    const r = ledgerRow({ status: "charged", creditsCharged: 0, creditsReserved: 3, source: "agent" });
    expect(ledgerCredits(r)).toEqual({ value: 0, basis: "charged" });
  });
});

describe("ledgerBucketLabel", () => {
  test("names the single bucket that paid", () => {
    expect(ledgerBucketLabel(ledgerRow())).toBe("starter 5");
  });

  test("a run across two buckets names both, in spend order", () => {
    const r = ledgerRow({ creditsFromTrial: 2, creditsFromSubscription: 3, creditsFromPurchased: 0, creditsFromOnDemand: 1 });
    expect(ledgerBucketLabel(r)).toBe("included 3 + starter 2 + on-demand 1");
  });

  test("a grant row paid from nothing renders a dash", () => {
    const r = ledgerRow({ eventType: "cycle_grant_included", creditsFromTrial: 0, creditsCharged: 0 });
    expect(ledgerBucketLabel(r)).toBe("–");
  });
});

describe("ledgerBucketNames", () => {
  test("names the bucket without repeating the amount the Credits column already shows", () => {
    expect(ledgerBucketNames(ledgerRow())).toBe("starter");
  });

  test("a run across two buckets names both, in spend order", () => {
    const r = ledgerRow({ creditsFromTrial: 2, creditsFromSubscription: 3, creditsFromPurchased: 0, creditsFromOnDemand: 1 });
    expect(ledgerBucketNames(r)).toBe("included + starter + on-demand");
  });

  test("a grant row paid from nothing renders a dash", () => {
    const r = ledgerRow({ eventType: "cycle_grant_included", creditsFromTrial: 0, creditsCharged: 0 });
    expect(ledgerBucketNames(r)).toBe("–");
  });
});

describe("graceState", () => {
  const now = new Date("2026-09-17T12:00:00.000Z");

  test("no grace subdocument", () => {
    expect(graceState(null, now)).toEqual({ state: "none", daysLeft: null });
  });

  test("counts the remaining days up, so a part-day is still a day", () => {
    const g = { startedAt: "2026-09-10T12:00:00.000Z", endsAt: "2026-09-24T00:00:00.000Z", blockedAt: null };
    expect(graceState(g, now)).toEqual({ state: "active", daysLeft: 7 });
  });

  test("blocked wins over the countdown", () => {
    const g = { startedAt: "2026-09-01T00:00:00.000Z", endsAt: "2026-09-15T00:00:00.000Z", blockedAt: "2026-09-15T00:00:00.000Z" };
    expect(graceState(g, now)).toEqual({ state: "blocked", daysLeft: 0 });
  });

  test("an expired window that was never blocked never goes negative", () => {
    const g = { startedAt: "2026-08-01T00:00:00.000Z", endsAt: "2026-09-01T00:00:00.000Z", blockedAt: null };
    expect(graceState(g, now)).toEqual({ state: "active", daysLeft: 0 });
  });
});

describe("usageVsLimit", () => {
  test("shows usage against a Free cap", () => {
    expect(usageVsLimit(2, 3)).toEqual({ text: "2 / 3", over: false });
  });

  test("flags being over the cap", () => {
    expect(usageVsLimit(11, 3)).toEqual({ text: "11 / 3", over: true });
  });

  test("an unlimited plan shows the bare count, never a cap it does not have", () => {
    expect(usageVsLimit(11, null)).toEqual({ text: "11", over: false });
  });

  test("a missing count is a dash, not zero", () => {
    expect(usageVsLimit(Number.NaN, 3)).toEqual({ text: "–", over: false });
  });
});

describe("small formatters", () => {
  test("fmtCount", () => {
    expect(fmtCount(0)).toBe("0");
    expect(fmtCount(null)).toBe("–");
    expect(fmtCount(undefined)).toBe("–");
  });

  test("fmtCents", () => {
    expect(fmtCents(1000)).toBe("$10.00");
    expect(fmtCents(0)).toBe("$0.00");
    expect(fmtCents(null)).toBe("–");
  });

  test("keyStateLabel", () => {
    const key: WorkspaceApiKeyDTO = {
      id: "k1",
      name: "Claude Code",
      prefix: "lnk_ab12cd34",
      scopes: ["read", "write"],
      createdDate: "2026-09-01T00:00:00.000Z",
      lastUsedAt: null,
      lastUsedClient: null,
      useCount: 0,
      revokedAt: null,
    };
    expect(keyStateLabel(key)).toBe("live");
    expect(keyStateLabel({ ...key, revokedAt: "2026-09-10T00:00:00.000Z" })).toBe("revoked");
  });
});
