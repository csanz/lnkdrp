/**
 * The admin user list has to report the plan the product actually enforces.
 *
 * `GET /api/admin/data/users` selected `plan: 1` off the user row and returned it, and
 * `/a/data/users` renders that value as the current plan (it is the value of the segmented plan
 * control, and the page description calls it "the current plan"). But `User.plan` is a
 * pre-workspaces field. Entitlement moved to the workspace: `getWorkspacePlan` reads the org's
 * `Subscription` row, and every limit, credit gate and `/api/billing/status` answer follows it. The
 * Stripe webhook writes `Subscription`; nothing writes `User.plan`, and
 * `POST /api/admin/users/:userId/plan` stopped pretending to when it started answering 501. With no
 * writer, the schema default `"free"` made the column a constant — a paying Pro customer rendered
 * as Free on the user list while the workspace hub two clicks away showed the live subscription,
 * and both buttons offered as the remedy refused the click.
 *
 * So the route resolves the plan from the `Subscription` rows of the workspaces the listed users
 * belong to, through `isProSubscription` — the same helper the hub, the limits and billing use.
 * That helper is real here, not mocked: the point of these tests is that the admin screen and the
 * enforcement path cannot disagree, and mocking the shared judgement away would let them.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const { ADMIN_ID, userRows, membershipRows, subscriptionRows, connectMongo, requireAdmin, membershipFind, subscriptionFind, userSelect } =
  vi.hoisted(() => {
    const ADMIN_ID = "64b0c0ffee0000000000a001";

    type UserRow = Record<string, unknown> & { _id: unknown };
    const userRows: UserRow[] = [];
    const membershipRows: Record<string, unknown>[] = [];
    const subscriptionRows: Record<string, unknown>[] = [];
    /** The projection the route asked the user collection for. */
    const userSelect: Record<string, unknown>[] = [];

    const membershipFind = vi.fn((filter: Record<string, unknown>) => {
      const ids = new Set(
        (((filter.userId as { $in?: unknown[] } | undefined)?.$in ?? []) as unknown[]).map((v) => String(v)),
      );
      return {
        select: () => ({
          lean: async () =>
            membershipRows.filter((m) => ids.has(String(m.userId)) && m.isDeleted !== true),
        }),
      };
    });

    const subscriptionFind = vi.fn((filter: Record<string, unknown>) => {
      const ids = new Set(
        (((filter.orgId as { $in?: unknown[] } | undefined)?.$in ?? []) as unknown[]).map((v) => String(v)),
      );
      return {
        select: () => ({
          lean: async () => subscriptionRows.filter((s) => ids.has(String(s.orgId)) && s.isDeleted !== true),
        }),
      };
    });

    return {
      ADMIN_ID,
      userRows,
      membershipRows,
      subscriptionRows,
      userSelect,
      membershipFind,
      subscriptionFind,
      connectMongo: vi.fn(async () => undefined),
      requireAdmin: vi.fn(async () => ({ ok: true as const, userId: ADMIN_ID, email: "staff@lnkdrp.com" })),
    };
  });

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/gating/requireAdmin", () => ({ requireAdmin }));
vi.mock("@/lib/models/User", () => ({
  UserModel: {
    countDocuments: vi.fn(async () => userRows.length),
    find: vi.fn(() => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({
            select: (projection: Record<string, unknown>) => {
              userSelect.push(projection);
              return {
                lean: async () =>
                  // A lean read only returns what was projected, so the route cannot see a field it
                  // did not ask for. `plan` is handed back whenever it is selected, exactly as Mongo
                  // would, so a route that reads it again fails these tests.
                  userRows.map((u) => {
                    const out: Record<string, unknown> = {};
                    for (const key of Object.keys(projection)) {
                      if (key in u) out[key] = u[key];
                    }
                    out._id = u._id;
                    return out;
                  }),
              };
            },
          }),
        }),
      }),
    })),
  },
  createTempUser: vi.fn(),
  verifyTempUserSecret: vi.fn(() => false),
}));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { find: membershipFind } }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: { find: subscriptionFind } }));

const { GET } = await import("@/app/api/admin/data/users/route");

const PAYING = new Types.ObjectId("64b0c0ffee0000000000b001");
const FREELOADER = new Types.ObjectId("64b0c0ffee0000000000b002");
const PERSONAL_ORG = new Types.ObjectId("64b0c0ffee0000000000c001");
const OTHER_ORG = new Types.ObjectId("64b0c0ffee0000000000c002");

/** A user row as Mongo holds it: `plan` present and stuck on the schema default, because nothing writes it. */
function addUser(id: Types.ObjectId, email: string, plan: string = "free") {
  userRows.push({ _id: id, email, name: email.split("@")[0], role: "user", plan, isActive: true, isTemp: false });
}

function addMembership(userId: Types.ObjectId, orgId: Types.ObjectId, isDeleted = false) {
  membershipRows.push({ userId, orgId, isDeleted });
}

function addSubscription(orgId: Types.ObjectId, row: { status: string; kind?: string | null; isDeleted?: boolean }) {
  subscriptionRows.push({ orgId, status: row.status, kind: row.kind ?? null, isDeleted: row.isDeleted ?? false });
}

/** `GET /api/admin/data/users`, returning the plan reported per email. */
async function listPlans(): Promise<Record<string, string>> {
  const res = await GET(new Request("http://localhost/api/admin/data/users?limit=50&page=1&role=user"));
  expect(res.status).toBe(200);
  const json = (await res.json()) as { users: { email: string; plan: string }[] };
  return Object.fromEntries(json.users.map((u) => [u.email, u.plan]));
}

beforeEach(() => {
  vi.clearAllMocks();
  userRows.length = 0;
  membershipRows.length = 0;
  subscriptionRows.length = 0;
  userSelect.length = 0;
});

describe("the plan the admin user list reports", () => {
  test("a customer with a live Pro subscription lists as Pro", async () => {
    addUser(PAYING, "chris@example.com");
    addMembership(PAYING, PERSONAL_ORG);
    addSubscription(PERSONAL_ORG, { status: "active", kind: "pro" });

    // Before the fix this was "free": the route read `User.plan`, which no code path writes, so
    // every account on the deployment rendered Free for ever.
    expect(await listPlans()).toEqual({ "chris@example.com": "pro" });
  });

  test("the stored User.plan is not consulted, in either direction", async () => {
    // A row that says "pro" with no subscription behind it. The legacy field has no writer, so a
    // value like this can only be residue; enforcement would give this person Free limits.
    addUser(FREELOADER, "stale@example.com", "pro");
    addMembership(FREELOADER, PERSONAL_ORG);

    expect(await listPlans()).toEqual({ "stale@example.com": "free" });
    // And the dead field is not even fetched, so the next reader cannot rediscover it here.
    for (const projection of userSelect) expect(projection).not.toHaveProperty("plan");
  });

  test("a pay-as-you-go subscription is active and still Free", async () => {
    addUser(PAYING, "card@example.com");
    addMembership(PAYING, PERSONAL_ORG);
    // A Free workspace that added a card gets an `active` subscription holding the metered credits
    // price alone. Status is not entitlement; `isProSubscription` is the one place that knows.
    addSubscription(PERSONAL_ORG, { status: "active", kind: "payg" });

    expect(await listPlans()).toEqual({ "card@example.com": "free" });
  });

  test("a cancelled subscription is Free, and a legacy row with no kind is Pro while it is billable", async () => {
    addUser(PAYING, "lapsed@example.com");
    addMembership(PAYING, PERSONAL_ORG);
    addSubscription(PERSONAL_ORG, { status: "canceled", kind: "pro" });
    addUser(FREELOADER, "legacy@example.com");
    addMembership(FREELOADER, OTHER_ORG);
    // Rows written before `kind` existed were all Pro; `subscriptionKind` reads null as "pro".
    addSubscription(OTHER_ORG, { status: "trialing", kind: null });

    expect(await listPlans()).toEqual({ "lapsed@example.com": "free", "legacy@example.com": "pro" });
  });

  test("Pro in any workspace counts, and one Pro workspace does not colour the people outside it", async () => {
    addUser(PAYING, "member@example.com");
    addUser(FREELOADER, "outsider@example.com");
    // The paying member's own workspace is Free; the team they belong to is Pro.
    addMembership(PAYING, PERSONAL_ORG);
    addMembership(PAYING, OTHER_ORG);
    addMembership(FREELOADER, PERSONAL_ORG);
    addSubscription(OTHER_ORG, { status: "active", kind: "pro" });

    expect(await listPlans()).toEqual({ "member@example.com": "pro", "outsider@example.com": "free" });
  });

  test("a removed membership and a deleted subscription row do not grant Pro", async () => {
    addUser(PAYING, "left@example.com");
    addMembership(PAYING, PERSONAL_ORG, true);
    addSubscription(PERSONAL_ORG, { status: "active", kind: "pro" });
    addUser(FREELOADER, "deleted@example.com");
    addMembership(FREELOADER, OTHER_ORG);
    addSubscription(OTHER_ORG, { status: "active", kind: "pro", isDeleted: true });

    expect(await listPlans()).toEqual({ "left@example.com": "free", "deleted@example.com": "free" });
  });

  test("an empty page asks the billing collections nothing", async () => {
    const res = await GET(new Request("http://localhost/api/admin/data/users?q=nobody"));

    expect(res.status).toBe(200);
    expect((await res.json()).users).toEqual([]);
    // Two extra queries per page is the budget; zero rows must cost zero.
    expect(membershipFind).not.toHaveBeenCalled();
    expect(subscriptionFind).not.toHaveBeenCalled();
  });
});
