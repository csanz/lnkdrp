import { describe, expect, test } from "vitest";

import { batchIdempotencyKey, groupOnDemandLedgersForStripe } from "@/lib/credits/stripeReporting";

describe("credits/stripeReporting", () => {
  test("groups only on-demand credits and ignores zeros", () => {
    const map = new Map<string, string>([
      ["w1", "si_1"],
      ["w2", "si_1"],
      ["w3", "si_2"],
    ]);
    const grouped = groupOnDemandLedgersForStripe({
      subscriptionItemIdByWorkspaceId: map,
      ledgers: [
        { id: "a", workspaceId: "w1", creditsFromOnDemand: 3 },
        { id: "b", workspaceId: "w1", creditsFromOnDemand: 0 },
        { id: "c", workspaceId: "w2", creditsFromOnDemand: 2 },
        { id: "d", workspaceId: "w3", creditsFromOnDemand: 5 },
        { id: "e", workspaceId: "w_missing", creditsFromOnDemand: 10 },
      ],
    });

    expect(grouped.get("si_1")?.quantity).toBe(5);
    expect(grouped.get("si_1")?.ledgerIds.sort()).toEqual(["a", "c"]);
    expect(grouped.get("si_2")?.quantity).toBe(5);
    expect(grouped.get("si_2")?.ledgerIds).toEqual(["d"]);
  });

  test("batch idempotency key is order-independent", () => {
    const a = batchIdempotencyKey({ subscriptionItemId: "si_1", ledgerIds: ["c", "a", "b"] });
    const b = batchIdempotencyKey({ subscriptionItemId: "si_1", ledgerIds: ["b", "c", "a"] });
    expect(a).toBe(b);
  });
});


