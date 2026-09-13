import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * The automatic AI compare tier is a plan-aware workspace default: Basic on Free, Standard on Pro,
 * unless an owner/admin stored a tier (which always wins).
 */
const state = {
  subscriptionStatus: null as string | null,
  storedHistoryTier: null as string | null | undefined,
};

/** `Model.findOne(...).select(...).lean()` chain resolving to `value()`. */
function findOneChain(value: () => unknown) {
  return vi.fn(() => ({
    select: vi.fn(() => ({
      lean: vi.fn(async () => value()),
    })),
  }));
}

vi.mock("@/lib/mongodb", () => ({
  connectMongo: vi.fn(async () => {}),
}));

vi.mock("@/lib/models/Subscription", () => ({
  SubscriptionModel: {
    findOne: findOneChain(() => (state.subscriptionStatus ? { status: state.subscriptionStatus } : null)),
  },
}));

vi.mock("@/lib/models/WorkspaceCreditBalance", () => ({
  WorkspaceCreditBalanceModel: {
    findOne: findOneChain(() =>
      state.storedHistoryTier === undefined ? null : { defaultHistoryQualityTier: state.storedHistoryTier },
    ),
  },
}));

// `planLimits` pulls in the counting models; they are never queried by `getWorkspacePlan`.
vi.mock("@/lib/models/Org", () => ({ OrgModel: {} }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: {} }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: {} }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: {} }));

import {
  defaultHistoryQualityTierForPlan,
  getDefaultHistoryQualityTier,
  parseQualityTier,
  resolveHistoryQualityTier,
} from "@/lib/credits/qualityDefaults";

const ORG_ID = "507f1f77bcf86cd799439011";

beforeEach(() => {
  state.subscriptionStatus = null;
  state.storedHistoryTier = null;
});

describe("credits/qualityDefaults pure helpers", () => {
  test("parseQualityTier accepts the three tiers (case/space-insensitive) and rejects the rest", () => {
    expect(parseQualityTier(" Basic ")).toBe("basic");
    expect(parseQualityTier("STANDARD")).toBe("standard");
    expect(parseQualityTier("advanced")).toBe("advanced");
    expect(parseQualityTier("premium")).toBeNull();
    expect(parseQualityTier(null)).toBeNull();
    expect(parseQualityTier(undefined)).toBeNull();
    expect(parseQualityTier(3)).toBeNull();
  });

  test("plan default: basic on Free, standard on Pro", () => {
    expect(defaultHistoryQualityTierForPlan("free")).toBe("basic");
    expect(defaultHistoryQualityTierForPlan("pro")).toBe("standard");
  });

  test("resolve: stored value wins, unset falls back to the plan default", () => {
    expect(resolveHistoryQualityTier("advanced", "free")).toBe("advanced");
    expect(resolveHistoryQualityTier("basic", "pro")).toBe("basic");
    expect(resolveHistoryQualityTier(null, "free")).toBe("basic");
    expect(resolveHistoryQualityTier(undefined, "pro")).toBe("standard");
    expect(resolveHistoryQualityTier("garbage", "pro")).toBe("standard");
  });
});

describe("credits/qualityDefaults getDefaultHistoryQualityTier", () => {
  test("Free + unset (null on the row) → basic", async () => {
    expect(await getDefaultHistoryQualityTier(ORG_ID)).toBe("basic");
  });

  test("Free + no balance row at all → basic", async () => {
    state.storedHistoryTier = undefined;
    expect(await getDefaultHistoryQualityTier(ORG_ID)).toBe("basic");
  });

  test.each(["active", "trialing"])("Pro (%s) + unset → standard", async (status) => {
    state.subscriptionStatus = status;
    expect(await getDefaultHistoryQualityTier(ORG_ID)).toBe("standard");
  });

  test("stored value wins on both plans", async () => {
    state.storedHistoryTier = "advanced";
    expect(await getDefaultHistoryQualityTier(ORG_ID)).toBe("advanced");

    state.subscriptionStatus = "active";
    state.storedHistoryTier = "basic";
    expect(await getDefaultHistoryQualityTier(ORG_ID)).toBe("basic");
  });

  test("a lapsed subscription is Free again → basic", async () => {
    state.subscriptionStatus = "canceled";
    expect(await getDefaultHistoryQualityTier(ORG_ID)).toBe("basic");
  });
});
