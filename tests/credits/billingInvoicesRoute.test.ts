import { describe, expect, test, vi } from "vitest";

const mockActor = {
  kind: "user",
  userId: "507f1f77bcf86cd799439012",
  orgId: "507f1f77bcf86cd799439011",
  personalOrgId: "507f1f77bcf86cd799439013",
};

vi.mock("@/lib/gating/actor", () => ({
  resolveActor: vi.fn(async () => mockActor),
  resolveActorForStats: vi.fn(async () => mockActor),
}));

vi.mock("@/lib/mongodb", () => ({
  connectMongo: vi.fn(async () => {}),
}));

/**
 * Invoices are owner/admin only — a viewer must not read the workspace's billing history.
 *
 * Mocked here because the route now asks, and an unmocked `requireOrgRole` reaches for a real Mongo
 * connection and hangs the test rather than failing it.
 */
vi.mock("@/lib/orgs/requireOrgRole", () => ({
  requireOrgRole: vi.fn(async () => ({ ok: true, role: "owner" })),
}));

vi.mock("@/lib/models/Subscription", () => ({
  SubscriptionModel: {
    findOne: vi.fn(() => ({
      select: vi.fn(() => ({
        lean: vi.fn(async () => null),
      })),
    })),
  },
}));

import { GET } from "@/app/api/billing/invoices/route";

describe("/api/billing/invoices", () => {
  test("returns empty invoices/months when stripeCustomerId missing", async () => {
    const res = await GET(new Request("http://localhost/api/billing/invoices?month=2026-01"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as any;
    expect(json.months).toEqual([]);
    expect(json.invoices).toEqual([]);
    expect(json.selectedMonth).toBe("2026-01");
  });
});
