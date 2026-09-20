/**
 * Who may open the workspace's Stripe billing portal (`POST /api/billing/subscription/manage`).
 *
 * The handler used to check that the caller had a membership row and nothing else, which is every
 * role in the workspace. A Stripe portal session cancels the plan, changes the card and lists every
 * past invoice — with the paying owner's name and billing address on it — so the read-only `viewer`
 * seat, the one handed to outside reviewers, could end the subscription for everyone and read the
 * owner's billing identity on the way out.
 *
 * Owner or admin, matching the dashboard's own `canManageBilling` and the `admin` gate on the
 * cancel branch of `/api/stripe/portal`: the plain portal reaches the same cancel screen, so a
 * lower bar here would just be that gate walked around.
 *
 * `requireOrgRole` runs for real against a mocked membership collection — the point of the test is
 * that the route consults the role at all, so stubbing the answer would test nothing.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const { ORG_ID, USER_ID, connectMongo, membershipFindOne, orgExists, subscriptionFindOne, createPortalSession, actor } =
  vi.hoisted(() => {
    const ORG_ID = "64b0c0ffee0000000000c001";
    const USER_ID = "64b0c0ffee0000000000c002";
    return {
      ORG_ID,
      USER_ID,
      connectMongo: vi.fn(async () => undefined),
      membershipFindOne: vi.fn(),
      orgExists: vi.fn(async () => null as unknown),
      subscriptionFindOne: vi.fn(),
      createPortalSession: vi.fn(async () => ({ url: "https://billing.stripe.test/session/abc" })),
      actor: {
        current: {
          kind: "user",
          userId: USER_ID,
          orgId: ORG_ID,
          personalOrgId: "64b0c0ffee0000000000c009",
        } as Record<string, unknown>,
      },
    };
  });

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { findOne: membershipFindOne } }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { exists: orgExists } }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: { findOne: subscriptionFindOne } }));
vi.mock("@/lib/gating/actor", () => ({
  tryResolveUserActorFast: vi.fn(async () => actor.current),
  resolveActor: vi.fn(async () => actor.current),
}));
vi.mock("stripe", () => ({
  default: class FakeStripe {
    billingPortal = { sessions: { create: createPortalSession } };
  },
}));

const { POST } = await import("@/app/api/billing/subscription/manage/route");

/** Mongoose `findOne(...).select(...).lean()` over a fixed row. */
function lean(doc: unknown) {
  return { select: () => ({ lean: async () => doc }) };
}

function asRole(role: string | null) {
  membershipFindOne.mockReturnValue(lean(role ? { role } : null));
}

function request() {
  return new Request("https://lnkdrp.test/api/billing/subscription/manage", { method: "POST" });
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.STRIPE_SECRET_KEY = "sk_test_billing_portal";
  actor.current = { kind: "user", userId: USER_ID, orgId: ORG_ID, personalOrgId: "64b0c0ffee0000000000c009" };
  subscriptionFindOne.mockReturnValue(lean({ stripeCustomerId: "cus_live_workspace" }));
  createPortalSession.mockResolvedValue({ url: "https://billing.stripe.test/session/abc" });
  orgExists.mockResolvedValue(null);
});

describe("POST /api/billing/subscription/manage", () => {
  test("a viewer is refused and no portal session is created", async () => {
    asRole("viewer");
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(createPortalSession).not.toHaveBeenCalled();
    // The session URL must not appear anywhere in the body, not even as an error detail.
    expect(await res.text()).not.toContain("billing.stripe.test");
  });

  test("a plain member is refused too: managing the plan is not an editing right", async () => {
    asRole("member");
    expect((await POST(request())).status).toBe(403);
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  test("someone with no membership row in the active workspace is refused", async () => {
    asRole(null);
    expect((await POST(request())).status).toBe(403);
    expect(createPortalSession).not.toHaveBeenCalled();
  });

  test("an admin gets a portal session for the workspace's own customer", async () => {
    asRole("admin");
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, url: "https://billing.stripe.test/session/abc" });
    expect(createPortalSession).toHaveBeenCalledTimes(1);
    const [params] = createPortalSession.mock.calls[0] as unknown as [{ customer: string }];
    expect(params.customer).toBe("cus_live_workspace");
  });

  test("an owner gets one as well", async () => {
    asRole("owner");
    expect((await POST(request())).status).toBe(200);
  });

  test("an API key is refused even when its owner is the workspace owner: a key does not spend money", async () => {
    asRole("owner");
    actor.current = { ...actor.current, viaApiKey: { keyId: "key_1", scopes: ["read", "write"] } };
    const res = await POST(request());
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: "api_key_forbidden" });
    expect(createPortalSession).not.toHaveBeenCalled();
  });
});
