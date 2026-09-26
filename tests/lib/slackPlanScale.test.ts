/**
 * Slack is gated by scale, not as a feature (decided 2026-09-26).
 *
 * A Free workspace keeps a channel and keeps every kind of post: the point of the integration is
 * that it works where the team already is, and a founder watching "Someone opened Series A deck"
 * land all week is being shown what Pro is for. What Pro buys is the *second* channel and the
 * routing that makes a second channel worth having.
 *
 * So the two things worth pinning are the two edges of that rule: the channel cap counts channels
 * and refuses the one past it, and routing a project is refused on Free while clearing one is not
 * (a workspace that drops to Pro's floor must be able to undo its own routing).
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const USER = new Types.ObjectId();
const CONNECTION = new Types.ObjectId();
const PROJECT = new Types.ObjectId();

const state = vi.hoisted(() => ({ plan: "free" as "free" | "pro", channels: 0 }));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: { findOne: () => ({ select: () => ({ lean: async () => null }) }) } }));
vi.mock("@/lib/billing/subscriptionState", () => ({ isProSubscription: () => state.plan === "pro" }));

const slackCountDocuments = vi.fn(async () => state.channels);
const slackUpdateOne = vi.fn(async (_filter?: Record<string, unknown>, _update?: Record<string, unknown>) => ({ acknowledged: true }));
const slackUpdateMany = vi.fn(async () => ({ acknowledged: true }));
const slackFindOne = vi.fn(() => ({ select: () => ({ lean: async () => ({ _id: CONNECTION }) }), lean: async () => ({ _id: CONNECTION }) }));
vi.mock("@/lib/models/SlackConnection", () => ({
  SlackConnectionModel: {
    countDocuments: slackCountDocuments,
    updateOne: slackUpdateOne,
    updateMany: slackUpdateMany,
    findOne: slackFindOne,
  },
}));

// The rest of the route's world: the actor is an admin of the workspace, and nothing else matters.
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: vi.fn(async () => ({ kind: "user", userId: String(USER), orgId: String(ORG), personalOrgId: String(ORG) })),
  applyTempUserHeaders: (res: Response) => res,
}));
vi.mock("@/lib/gating/forbidApiKey", () => ({ forbidApiKey: () => null }));
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole: vi.fn(async () => ({ ok: true, role: "admin" })) }));
vi.mock("@/lib/db/mongoRequestLogger", () => ({ withMongoRequestLogging: (_r: Request, fn: () => Promise<Response>) => fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { exists: async () => true } }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findOne: () => ({ select: () => ({ lean: async () => null }) }) } }));
vi.mock("@/lib/slack/config", () => ({ slackEnabled: () => true }));
vi.mock("@/lib/slack/connections", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/slack/connections")>()),
  listSlackConnections: async () => [],
  serializeSlackConnection: (r: unknown) => r,
}));

const { checkLimit, FREE_SLACK_CHANNELS } = await import("@/lib/billing/planLimits");
const { PATCH } = await import("@/app/api/orgs/active/slack/route");

/** PATCH the settings route and insist on an answer; the handler's type allows undefined. */
async function patch(body: Record<string, unknown>): Promise<Response> {
  const res = await PATCH(
    new Request("http://localhost/api/orgs/active/slack", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
  if (!res) throw new Error("the route answered nothing");
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  state.plan = "free";
  state.channels = 0;
});

describe("the channel cap counts channels", () => {
  test("Free connects its first channel and is refused the next", async () => {
    state.channels = 0;
    expect((await checkLimit(ORG, "slack_channels")).ok).toBe(true);

    state.channels = FREE_SLACK_CHANNELS;
    const blocked = await checkLimit(ORG, "slack_channels");
    expect(blocked.ok).toBe(false);
    if (blocked.ok) return;
    expect(blocked.limit).toBe("slack_channels");
    expect(blocked.used).toBe(FREE_SLACK_CHANNELS);
    expect(blocked.max).toBe(FREE_SLACK_CHANNELS);
    // A cap, not a gate: the message says what Pro adds, not that Slack is a Pro feature.
    expect(blocked.message).toContain("Upgrade to Pro");
    expect(blocked.message).not.toMatch(/Slack is a Pro feature/i);
  });

  test("Pro is not counted at all", async () => {
    state.plan = "pro";
    state.channels = 12;
    expect((await checkLimit(ORG, "slack_channels")).ok).toBe(true);
  });

  test("the cap is a count, so the check never claims grace it cannot have", async () => {
    state.channels = FREE_SLACK_CHANNELS;
    const blocked = await checkLimit(ORG, "slack_channels");
    if (blocked.ok) throw new Error("expected blocked");
    expect(blocked.grace).toBeNull();
  });
});

describe("routing a project to a channel", () => {
  test("Free is refused with a 402 the upgrade prompt understands, and nothing is written", async () => {
    const res = await patch({ connectionId: String(CONNECTION), projectIds: [String(PROJECT)] });
    expect(res.status).toBe(402);
    const body = (await res.json()) as { code?: string; limit?: string };
    expect(body.code).toBe("plan_limit");
    expect(body.limit).toBe("slack_routing");
    expect(slackUpdateOne).not.toHaveBeenCalled();
    expect(slackUpdateMany).not.toHaveBeenCalled();
  });

  test("Free may still clear a routing it already has", async () => {
    const res = await patch({ connectionId: String(CONNECTION), projectIds: [] });
    expect(res.status).toBe(200);
    expect(slackUpdateOne).toHaveBeenCalled();
  });

  test("Free may still change which events post, because the posts are not what Pro buys", async () => {
    const res = await patch({ connectionId: String(CONNECTION), events: { views: false, briefs: true } });
    expect(res.status).toBe(200);
    const set = slackUpdateOne.mock.calls.at(-1)?.[1] as { $set?: Record<string, unknown> } | undefined;
    expect(set?.$set).toMatchObject({ "events.views": false, "events.briefs": true });
  });

  test("Pro routes a project, and the project leaves every other channel", async () => {
    state.plan = "pro";
    const res = await patch({ connectionId: String(CONNECTION), projectIds: [String(PROJECT)] });
    expect(res.status).toBe(200);
    expect(slackUpdateMany).toHaveBeenCalled();
    expect(slackUpdateOne).toHaveBeenCalled();
  });
});
