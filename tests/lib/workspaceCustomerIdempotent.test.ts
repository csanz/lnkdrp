/**
 * `ensureWorkspaceStripeCustomer` creates the customer idempotently and never revives a deleted
 * Subscription row (code review 2026-09-23, Billing / identity).
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  orgFindOne: vi.fn(),
  subFindOne: vi.fn(),
  subUpdateOne: vi.fn(async () => ({ matchedCount: 1 })),
}));

vi.mock("@/lib/models/Org", () => ({
  OrgModel: { findOne: () => ({ select: () => ({ lean: () => mocks.orgFindOne() }) }) },
}));
vi.mock("@/lib/models/Subscription", () => ({
  SubscriptionModel: {
    findOne: (filter: unknown) => ({ select: () => ({ lean: () => mocks.subFindOne(filter) }) }),
    updateOne: mocks.subUpdateOne,
  },
}));

import { ensureWorkspaceStripeCustomer } from "@/lib/billing/workspaceCustomer";

const ORG = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const USER = new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");

function stripeStub() {
  const create = vi.fn(async () => ({ id: "cus_new" }));
  const update = vi.fn(async () => ({}));
  return { stripe: { customers: { create, update } } as never, create, update };
}

describe("ensureWorkspaceStripeCustomer", () => {
  beforeEach(() => {
    mocks.orgFindOne.mockReset().mockResolvedValue({ name: "Vantridge", type: "team" });
    mocks.subFindOne.mockReset().mockResolvedValue(null);
    mocks.subUpdateOne.mockClear();
  });

  it("creates with an idempotency key bound to the workspace", async () => {
    const { stripe, create } = stripeStub();
    const out = await ensureWorkspaceStripeCustomer({ stripe, orgId: ORG, userId: USER, email: "c@x.test" });
    expect(out.customerId).toBe("cus_new");
    const [, opts] = (create.mock.calls as unknown[][])[0] as [unknown, { idempotencyKey?: string }];
    expect(opts.idempotencyKey).toBe(`workspace-customer:${String(ORG)}`);
  });

  it("looks up and writes the live Subscription row only", async () => {
    const { stripe } = stripeStub();
    await ensureWorkspaceStripeCustomer({ stripe, orgId: ORG, userId: USER, email: null });
    const [lookup] = (mocks.subFindOne.mock.calls as unknown[][])[0] as [Record<string, unknown>];
    expect(lookup).toMatchObject({ orgId: ORG, isDeleted: { $ne: true } });
    const [filter] = (mocks.subUpdateOne.mock.calls as unknown[][])[0] as [Record<string, unknown>];
    expect(filter).toEqual({ orgId: ORG, isDeleted: { $ne: true } });
  });

  it("reuses a stored customer without creating", async () => {
    mocks.subFindOne.mockResolvedValue({ stripeCustomerId: "cus_old" });
    const { stripe, create } = stripeStub();
    const out = await ensureWorkspaceStripeCustomer({ stripe, orgId: ORG, userId: USER, email: null });
    expect(out.customerId).toBe("cus_old");
    expect(create).not.toHaveBeenCalled();
  });
});
