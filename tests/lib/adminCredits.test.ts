/**
 * The admin credits rules (`src/lib/admin/creditsAdmin.ts`).
 *
 * The anomaly list on `/a/credits` accuses a workspace of being broken, so each rule has to fire on
 * exactly the states the writing code could not have produced and stay quiet on the ones it could:
 * a Free workspace holding its full starter grant and a 15/day brake is normal, the same row on Pro
 * is a cycle grant that never ran. These tests pin that boundary, and the last block pins the constants
 * the routes feed in, so a change to the credit rules fails here rather than silently re-labelling
 * healthy workspaces.
 */
import { describe, expect, test, vi } from "vitest";

import {
  STALE_PENDING_MS,
  balanceAnomalies,
  bucketSplitLabel,
  compareByRunway,
  creditPlanFor,
  creditsShown,
  fmtAge,
  fmtCents,
  fmtCredits,
  isPurchasePastExpiry,
  isStalePending,
  reachablePageCount,
  totalCreditsRemaining,
  type AdminCreditPlan,
  type CreditRuleLimits,
} from "@/lib/admin/creditsAdmin";

/** Today's rules, as the routes pass them in. */
const LIMITS: CreditRuleLimits = { starterGrant: 100, includedPerCycle: 500, freeDailyCap: 15 };

/** A workspace in the state the seed code actually leaves it in, for the plan given. */
function healthy(plan: AdminCreditPlan) {
  return plan === "pro"
    ? {
        plan,
        buckets: { starter: 0, included: LIMITS.includedPerCycle, purchased: 0 },
        dailyCreditCap: null,
        onDemandEnabled: true,
        onDemandMonthlyLimitCents: 1000,
        limits: LIMITS,
      }
    : {
        plan,
        buckets: { starter: LIMITS.starterGrant, included: 0, purchased: 0 },
        dailyCreditCap: 15,
        onDemandEnabled: false,
        onDemandMonthlyLimitCents: 0,
        limits: LIMITS,
      };
}

/** Just the codes a state raises, for readable assertions. */
function codes(params: Parameters<typeof balanceAnomalies>[0]): string[] {
  return balanceAnomalies(params).map((a) => a.code);
}

describe("admin/creditsAdmin — plan resolution", () => {
  test("Pro is a billable subscription carrying the Pro price", () => {
    expect(creditPlanFor({ status: "active", kind: "pro" })).toBe("pro");
    expect(creditPlanFor({ status: "trialing", kind: "pro" })).toBe("pro");
  });

  test("a legacy row with no kind reads as Pro, because every row predating the field was", () => {
    expect(creditPlanFor({ status: "active" })).toBe("pro");
  });

  test("a Free workspace with a card is payg, not Pro", () => {
    expect(creditPlanFor({ status: "active", kind: "payg" })).toBe("payg");
  });

  test("no subscription, or a dead one, is free", () => {
    expect(creditPlanFor(null)).toBe("free");
    expect(creditPlanFor({ status: "canceled", kind: "pro" })).toBe("free");
    expect(creditPlanFor({ status: "past_due", kind: "payg" })).toBe("free");
  });
});

describe("admin/creditsAdmin — balance anomalies stay quiet on healthy rows", () => {
  test("a freshly seeded Free workspace raises nothing", () => {
    expect(codes(healthy("free"))).toEqual([]);
  });

  test("a Pro workspace with its cycle grant applied raises nothing", () => {
    expect(codes(healthy("pro"))).toEqual([]);
  });

  test("a spent-down workspace is not an anomaly: zero credits is a normal state", () => {
    expect(codes({ ...healthy("free"), buckets: { starter: 0, included: 0, purchased: 0 } })).toEqual([]);
  });

  test("a pay-as-you-go workspace keeps Free's starter grant and brake without complaint", () => {
    expect(codes(healthy("payg"))).toEqual([]);
  });

  test("a Pro workspace still holding purchased credits is fine — packs survive an upgrade", () => {
    expect(codes({ ...healthy("pro"), buckets: { starter: 0, included: 120, purchased: 30 } })).toEqual([]);
  });
});

describe("admin/creditsAdmin — balance anomalies fire on impossible rows", () => {
  test("a negative bucket, which the schema's min:0 forbids", () => {
    const found = balanceAnomalies({ ...healthy("free"), buckets: { starter: -5, included: 0, purchased: 0 } });
    expect(found.map((a) => a.code)).toEqual(["negative_balance"]);
    expect(found[0]).toMatchObject({ severity: "high", detail: "starter=-5" });
  });

  test("every negative bucket is named in one finding", () => {
    const found = balanceAnomalies({ ...healthy("free"), buckets: { starter: -1, included: 0, purchased: -2 } });
    expect(found[0].detail).toBe("starter=-1, purchased=-2");
  });

  test("more starter credits than the one-time grant", () => {
    // Derived from LIMITS, not written out: these numbers are "over" and "exactly at" the grant,
    // and a pricing change that moves the grant must not silently turn them into neither. Raising
    // the starter grant to 100 did exactly that to the literals that used to sit here.
    const over = { starter: LIMITS.starterGrant + 1, included: 0, purchased: 0 };
    expect(codes({ ...healthy("free"), buckets: over })).toContain("starter_over_grant");
  });

  test("exactly the grant is not over it", () => {
    const exact = { starter: LIMITS.starterGrant, included: 0, purchased: 0 };
    expect(codes({ ...healthy("free"), buckets: exact })).not.toContain("starter_over_grant");
  });

  test("on-demand enabled off Pro, where the snapshot forces it off anyway", () => {
    expect(codes({ ...healthy("free"), onDemandEnabled: true })).toContain("on_demand_off_plan");
    expect(codes({ ...healthy("payg"), onDemandMonthlyLimitCents: 1000 })).toContain("on_demand_off_plan");
  });

  test("on-demand on Pro is the supported configuration", () => {
    expect(codes(healthy("pro"))).not.toContain("on_demand_off_plan");
  });

  test("the Free daily brake left on a Pro workspace", () => {
    const found = balanceAnomalies({ ...healthy("pro"), dailyCreditCap: 15 });
    expect(found.map((a) => a.code)).toEqual(["pro_daily_brake"]);
    expect(found[0].severity).toBe("high");
    expect(found[0].detail).toContain("Free is 15");
  });

  test("included credits on a workspace that is not paying for them", () => {
    expect(
      codes({ ...healthy("free"), buckets: { starter: LIMITS.starterGrant, included: 120, purchased: 0 } }),
    ).toContain("free_holds_included");
  });

  test("more included credits than a cycle grants, with no rollover to explain it", () => {
    const found = codes({
      ...healthy("pro"),
      buckets: { starter: 0, included: LIMITS.includedPerCycle + 1, purchased: 0 },
    });
    expect(found).toEqual(["included_over_grant"]);
  });

  test("a cancelled Pro that kept its cycle credits trips both plan rules", () => {
    expect(
      codes({ ...healthy("free"), buckets: { starter: 0, included: LIMITS.includedPerCycle, purchased: 0 } }),
    ).toEqual(["free_holds_included"]);
  });

  test("the rules follow the constants passed in, not hardcoded numbers", () => {
    const limits: CreditRuleLimits = { starterGrant: 10, includedPerCycle: 100, freeDailyCap: 5 };
    expect(codes({ ...healthy("free"), limits, buckets: { starter: 50, included: 0, purchased: 0 } })).toContain(
      "starter_over_grant",
    );
    expect(codes({ ...healthy("pro"), limits, buckets: { starter: 0, included: 300, purchased: 0 } })).toContain(
      "included_over_grant",
    );
  });
});

describe("admin/creditsAdmin — stale reservations", () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);

  test("a pending row older than an hour", () => {
    expect(isStalePending({ status: "pending", createdAtMs: now - STALE_PENDING_MS - 1000, nowMs: now })).toBe(true);
  });

  test("a pending row inside the hour is just a run in flight", () => {
    expect(isStalePending({ status: "pending", createdAtMs: now - 60_000, nowMs: now })).toBe(false);
  });

  test("a settled row is never stale, however old", () => {
    for (const status of ["charged", "refunded", "failed"]) {
      expect(isStalePending({ status, createdAtMs: now - 30 * 86_400_000, nowMs: now })).toBe(false);
    }
  });
});

describe("admin/creditsAdmin — purchases past their expiry", () => {
  const now = Date.UTC(2026, 8, 17, 12, 0, 0);

  test("due and not yet reclaimed", () => {
    expect(isPurchasePastExpiry({ expiresAtMs: now - 86_400_000, expiredAtMs: null, nowMs: now })).toBe(true);
  });

  test("due but already reclaimed by the expiry job", () => {
    expect(isPurchasePastExpiry({ expiresAtMs: now - 86_400_000, expiredAtMs: now - 3600_000, nowMs: now })).toBe(false);
  });

  test("still live", () => {
    expect(isPurchasePastExpiry({ expiresAtMs: now + 86_400_000, expiredAtMs: null, nowMs: now })).toBe(false);
  });

  test("a row with no expiry date is not accused; there is nothing to compare against", () => {
    expect(isPurchasePastExpiry({ expiresAtMs: null, expiredAtMs: null, nowMs: now })).toBe(false);
  });
});

describe("admin/creditsAdmin — shaping", () => {
  test("credits held exclude on-demand headroom, which is permission to be billed", () => {
    expect(totalCreditsRemaining({ starter: 12, included: 300, purchased: 30 })).toBe(342);
  });

  test("the runway order puts the emptiest workspace first, ties broken by id", () => {
    const rows = [
      { workspaceId: "b", totalRemaining: 10 },
      { workspaceId: "a", totalRemaining: 0 },
      { workspaceId: "c", totalRemaining: 0 },
    ];
    expect([...rows].sort(compareByRunway).map((r) => r.workspaceId)).toEqual(["a", "c", "b"]);
  });

  test("the bucket label names every bucket that paid", () => {
    expect(bucketSplitLabel({ starter: 0, subscription: 5, purchased: 0, onDemand: 0 })).toBe("subscription");
    expect(bucketSplitLabel({ starter: 2, subscription: 0, purchased: 3, onDemand: 0 })).toBe("starter + purchased");
    expect(bucketSplitLabel({ starter: 0, subscription: 1, purchased: 0, onDemand: 4 })).toBe("subscription + on-demand");
  });

  test("a row that drew on no bucket — a grant, or a 0-credit recipient run — shows a dash", () => {
    expect(bucketSplitLabel({ starter: 0, subscription: 0, purchased: 0, onDemand: 0 })).toBe("–");
  });

  test("money and credits format the way the pricing page writes them", () => {
    expect(fmtCents(3900)).toBe("$39");
    expect(fmtCents(450)).toBe("$4.50");
    expect(fmtCents(10)).toBe("$0.10");
    expect(fmtCredits(300)).toBe("300");
    expect(fmtCredits(2.5)).toBe("2.50");
  });

  test("ages are compact and never negative", () => {
    expect(fmtAge(90 * 60_000)).toBe("1h");
    expect(fmtAge(5 * 60_000)).toBe("5m");
    expect(fmtAge(5 * 86_400_000)).toBe("5d");
    expect(fmtAge(-1000)).toBe("0m");
  });
});

describe("admin/creditsAdmin — the constants the routes feed in", () => {
  test("match the credit rules in force today", async () => {
    // These modules reach for Mongo at import time; the rules themselves are plain constants.
    vi.doMock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
    const { FREE_STARTER_CREDITS, INCLUDED_CREDITS_PER_CYCLE } = await import("@/lib/credits/grants");
    const { FREE_DAILY_CREDIT_CAP } = await import("@/lib/credits/creditService");
    expect({
      starterGrant: FREE_STARTER_CREDITS,
      includedPerCycle: INCLUDED_CREDITS_PER_CYCLE,
      freeDailyCap: FREE_DAILY_CREDIT_CAP,
    }).toEqual(LIMITS);
  });
});

describe("admin/creditsAdmin — reachablePageCount", () => {
  // The balances route refuses any page reaching past 2000 rows, so a pager built from `total`
  // alone offers pages that can only ever answer 400.
  const WINDOW = { pageSize: 50, maxWindow: 2000 };

  test("stops at the window rather than at the total", () => {
    expect(reachablePageCount({ total: 5000, ...WINDOW })).toBe(40);
  });

  test("stops at the total when the collection is smaller than the window", () => {
    expect(reachablePageCount({ total: 120, ...WINDOW })).toBe(3);
  });

  test("the last page of a window that divides exactly is still reachable", () => {
    expect(reachablePageCount({ total: 2000, ...WINDOW })).toBe(40);
  });

  test("an empty collection still has one page", () => {
    expect(reachablePageCount({ total: 0, ...WINDOW })).toBe(1);
  });

  test("a window smaller than one page never reports zero pages", () => {
    expect(reachablePageCount({ total: 500, pageSize: 50, maxWindow: 10 })).toBe(1);
  });

  test("no window known falls back to the total", () => {
    expect(reachablePageCount({ total: 500, pageSize: 50, maxWindow: 0 })).toBe(10);
  });

  test("a nonsense page size never divides by zero", () => {
    expect(reachablePageCount({ total: 500, pageSize: 0, maxWindow: 2000 })).toBe(1);
  });
});

describe("admin/creditsAdmin — creditsShown", () => {
  const row = (over: Partial<Parameters<typeof creditsShown>[0]>) => ({
    status: "pending",
    creditsCharged: 0,
    creditsReserved: 0,
    creditsEstimated: 0,
    ...over,
  });

  test("a pending row reports what it reserved, not the 0 it has been charged", () => {
    expect(creditsShown(row({ status: "pending", creditsReserved: 3, creditsEstimated: 3 }))).toEqual({
      value: 3,
      basis: "reserved",
    });
  });

  test("a charged row reports the charge", () => {
    expect(creditsShown(row({ status: "charged", creditsCharged: 2, creditsReserved: 3 }))).toEqual({
      value: 2,
      basis: "charged",
    });
  });

  test("a charged row that cost nothing still reads as charged, not as its reservation", () => {
    expect(creditsShown(row({ status: "charged", creditsCharged: 0, creditsReserved: 3 }))).toEqual({
      value: 0,
      basis: "charged",
    });
  });

  test("a row with neither falls back to the estimate", () => {
    expect(creditsShown(row({ status: "failed", creditsEstimated: 5 }))).toEqual({
      value: 5,
      basis: "estimated",
    });
  });

  test("a row with no status at all is still readable", () => {
    expect(creditsShown(row({ status: null, creditsCharged: 4 }))).toEqual({ value: 4, basis: "charged" });
  });
});
