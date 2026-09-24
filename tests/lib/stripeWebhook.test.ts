/**
 * `POST /api/stripe/webhook`: the invariants that keep a workspace's plan honest.
 *
 * Stripe does not promise delivery order and this route answers 400 on a processing error so
 * Stripe retries. The handler carries four guards against what that combination can do, and until
 * this file none of them was tested:
 *
 * - **Duplicate ack**: an event already marked `processedAt` is acknowledged with no write.
 * - **Failed-attempt retry**: an event row with `processedAt: null` (a previous 400) is processed.
 * - **Out-of-order ignore**: an event older than the row's `lastStripeEventAt` changes nothing,
 *   and does so quietly. The ordered filter and the upsert used to fight: the filter matched
 *   nothing, the upsert inserted a second row for the org, the unique index refused, the route
 *   threw, and Stripe retried the same stale event for three days.
 * - **Foreign-subscription ignore**: an event for a subscription id other than the one the row
 *   tracks, while the tracked one is still open, is dropped. Otherwise two subscriptions on one
 *   customer take turns overwriting the row.
 *
 * Plus the Free daily brake: restored when a subscription stops being billable, lifted again when
 * it recovers inside the same cycle (a cycle grant is idempotent, so it would not lift it).
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectMongo: vi.fn(async () => undefined),
  constructEvent: vi.fn((body: string) => JSON.parse(body)),
  subscriptionsRetrieve: vi.fn(),
  eventCreate: vi.fn(),
  eventFindOne: vi.fn(),
  eventUpdateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  subFindOne: vi.fn(),
  subUpdateOne: vi.fn(),
  balanceUpdateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
  grantCycleIncludedCredits: vi.fn(async () => undefined),
  logErrorEvent: vi.fn(async () => undefined),
}));

vi.mock("stripe", () => ({
  default: class StripeMock {
    webhooks = { constructEvent: mocks.constructEvent };
    subscriptions = { retrieve: mocks.subscriptionsRetrieve };
  },
}));
vi.mock("@/lib/mongodb", () => ({ connectMongo: mocks.connectMongo }));
vi.mock("@/lib/debug", () => ({ debugLog: () => undefined }));
vi.mock("@/lib/urls", () => ({ resolveConfiguredSiteUrl: () => null }));
vi.mock("@/lib/models/StripeEvent", () => ({
  StripeEventModel: { create: mocks.eventCreate, findOne: mocks.eventFindOne, updateOne: mocks.eventUpdateOne },
}));
vi.mock("@/lib/models/Subscription", () => ({
  SubscriptionModel: { findOne: mocks.subFindOne, updateOne: mocks.subUpdateOne },
}));
vi.mock("@/lib/models/WorkspaceCreditBalance", () => ({
  WorkspaceCreditBalanceModel: { updateOne: mocks.balanceUpdateOne },
}));
vi.mock("@/lib/credits/grants", () => ({
  grantCycleIncludedCredits: mocks.grantCycleIncludedCredits,
  buildCycleKey: () => "cycle",
  creditWindowIndex: () => 0,
}));
vi.mock("@/lib/credits/stripeReporting", () => ({ getAiCreditsPriceId: () => "price_credits" }));
vi.mock("@/lib/credits/summaryRequeue", () => ({ requeueSkippedSummaries: vi.fn(async () => undefined) }));
vi.mock("@/lib/credits/purchases", () => ({ grantCreditPack: vi.fn() }));
vi.mock("@/lib/credits/creditService", () => ({ FREE_DAILY_CREDIT_CAP: 15 }));
vi.mock("@/lib/errors/logger", () => ({
  logErrorEvent: mocks.logErrorEvent,
  ERROR_CODE_STRIPE_WEBHOOK_INVALID_SIGNATURE: "STRIPE_WEBHOOK_INVALID_SIGNATURE",
  ERROR_CODE_STRIPE_WEBHOOK_PROCESSING_FAILED: "STRIPE_WEBHOOK_PROCESSING_FAILED",
}));

process.env.STRIPE_SECRET_KEY = "sk_test_x";
process.env.STRIPE_WEBHOOK_SECRET = "whsec_x";
process.env.STRIPE_PRICE_ID = "price_pro";
process.env.STRIPE_PRICE_ID_ANNUAL = "price_pro_year";

const { POST } = await import("@/app/api/stripe/webhook/route");

const ORG_ID = "66f0a2b3c4d5e6f7a8b9c0d1";
const PERIOD_START = 1_760_000_000;
const PERIOD_END = PERIOD_START + 30 * 24 * 3600;

/** A lean-query chain (`findOne().select().lean()`) resolving to `value`. */
function chain<T>(value: T) {
  const c = { select: () => c, lean: async () => value };
  return c;
}

/** A mongoose-shaped duplicate-key error. */
function dupKey() {
  return Object.assign(new Error("E11000 duplicate key error"), { code: 11000 });
}

type SubFixture = { id: string; status: string; orgId?: string | null; created?: number; interval?: "month" | "year" };

function subscriptionObject(f: SubFixture) {
  const yearly = f.interval === "year";
  return {
    id: f.id,
    customer: "cus_1",
    status: f.status,
    metadata: f.orgId === null ? {} : { orgId: f.orgId ?? ORG_ID, kind: "pro" },
    cancel_at: null,
    cancel_at_period_end: false,
    items: {
      data: [
        {
          id: yearly ? "si_pro_year" : "si_pro",
          price: {
            id: yearly ? "price_pro_year" : "price_pro",
            recurring: { interval: yearly ? "year" : "month", usage_type: "licensed" },
          },
          current_period_start: PERIOD_START,
          current_period_end: yearly ? PERIOD_START + 365 * 24 * 3600 : PERIOD_END,
        },
        // Monthly Pro carries the metered credits item beside the licensed one; yearly cannot.
        ...(yearly
          ? []
          : [{ id: "si_credits", price: { id: "price_credits", recurring: { interval: "month", usage_type: "metered" } } }]),
      ],
    },
  };
}

function subscriptionEvent(type: string, f: SubFixture, eventId = "evt_1") {
  return { id: eventId, type, created: f.created ?? PERIOD_START, data: { object: subscriptionObject(f) } };
}

async function post(event: unknown) {
  // The handler re-fetches the subscription from Stripe whenever the payload lacks `cancel_at`
  // (always, here) and prefers the fetched status, so the fetch must agree with the event.
  const obj = (event as { data?: { object?: unknown } })?.data?.object;
  if (obj) mocks.subscriptionsRetrieve.mockImplementation(async () => obj);
  const req = new Request("https://lnkdrp.test/api/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": "t=1,v1=sig" },
    body: JSON.stringify(event),
  });
  const res = await POST(req);
  return { status: res.status, json: (await res.json()) as Record<string, unknown> };
}

/** The `updateOne` calls that touched the subscription row, as `[filter, update, options]`. */
function subWrites() {
  return mocks.subUpdateOne.mock.calls as Array<[Record<string, any>, Record<string, any>, Record<string, any> | undefined]>;
}

beforeEach(() => {
  mocks.eventCreate.mockResolvedValue(undefined);
  mocks.eventFindOne.mockReturnValue(chain(null));
  mocks.subFindOne.mockReturnValue(chain(null));
  mocks.subUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1, upsertedCount: 0 });
  mocks.subscriptionsRetrieve.mockImplementation(async (id: string) => subscriptionObject({ id, status: "active" }));
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("idempotency", () => {
  test("an event already processed is acknowledged without touching the subscription", async () => {
    mocks.eventCreate.mockRejectedValueOnce(dupKey());
    mocks.eventFindOne.mockReturnValueOnce(chain({ processedAt: new Date() }));

    const { status, json } = await post(subscriptionEvent("customer.subscription.updated", { id: "sub_A", status: "active" }));

    expect(status).toBe(200);
    expect(json.alreadyProcessed).toBe(true);
    expect(mocks.subUpdateOne).not.toHaveBeenCalled();
    expect(mocks.eventUpdateOne).not.toHaveBeenCalled();
  });

  test("an event whose first attempt failed (row present, processedAt null) is processed again", async () => {
    mocks.eventCreate.mockRejectedValueOnce(dupKey());
    mocks.eventFindOne.mockReturnValueOnce(chain({ processedAt: null }));

    const { status, json } = await post(subscriptionEvent("customer.subscription.updated", { id: "sub_A", status: "active" }));

    expect(status).toBe(200);
    expect(json.alreadyProcessed).toBeUndefined();
    expect(subWrites().length).toBeGreaterThan(0);
    expect(mocks.eventUpdateOne).toHaveBeenCalledWith({ eventId: "evt_1" }, { $set: { processedAt: expect.any(Date) } });
  });
});

describe("ordering", () => {
  test("a stale event that loses to the row's stamp is ignored, not thrown, and Stripe is not asked to retry", async () => {
    // The ordered filter excludes the row; the upsert then collides with the unique {orgId} index.
    mocks.subUpdateOne.mockRejectedValueOnce(dupKey());
    mocks.subUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 });

    const { status } = await post(
      subscriptionEvent("customer.subscription.updated", { id: "sub_A", status: "active", created: PERIOD_START - 100 }),
    );

    expect(status).toBe(200);
    expect(mocks.logErrorEvent).not.toHaveBeenCalled();
    const writes = subWrites();
    expect(writes).toHaveLength(2);
    // First attempt: ordered filter with the upsert. Retry: same ordered filter, no upsert.
    expect(writes[0][0].$or).toBeDefined();
    expect(writes[0][2]).toEqual({ upsert: true });
    expect(writes[1][0].$or).toEqual(writes[0][0].$or);
    expect(writes[1][2]).toBeUndefined();
    // The stale event granted nothing.
    expect(mocks.grantCycleIncludedCredits).not.toHaveBeenCalled();
  });

  test("the event that wins the ordering check writes the row and grants the cycle", async () => {
    const { status } = await post(subscriptionEvent("customer.subscription.updated", { id: "sub_A", status: "active" }));

    expect(status).toBe(200);
    const [filter, update] = subWrites()[0];
    expect(filter.orgId).toBeDefined();
    expect(update.$set.status).toBe("active");
    expect(update.$set.stripeSubscriptionId).toBe("sub_A");
    expect(update.$set.lastStripeEventAt).toBeInstanceOf(Date);
    expect(mocks.grantCycleIncludedCredits).toHaveBeenCalledTimes(1);
  });
});

describe("one subscription per workspace", () => {
  test("an event for a subscription the workspace does not track is dropped while the tracked one is open", async () => {
    mocks.subFindOne.mockReturnValue(chain({ stripeSubscriptionId: "sub_B", status: "active" }));

    const { status } = await post(subscriptionEvent("customer.subscription.updated", { id: "sub_A", status: "unpaid" }));

    expect(status).toBe(200);
    expect(mocks.subUpdateOne).not.toHaveBeenCalled();
    expect(mocks.balanceUpdateOne).not.toHaveBeenCalled();
    expect(mocks.grantCycleIncludedCredits).not.toHaveBeenCalled();
  });

  test("a new subscription replaces a finished one (resubscribe after cancel)", async () => {
    mocks.subFindOne.mockReturnValue(chain({ stripeSubscriptionId: "sub_OLD", status: "free", orgId: ORG_ID }));

    const { status } = await post(subscriptionEvent("customer.subscription.created", { id: "sub_NEW", status: "active" }));

    expect(status).toBe(200);
    const [, update] = subWrites()[0];
    expect(update.$set.stripeSubscriptionId).toBe("sub_NEW");
    expect(update.$set.status).toBe("active");
  });

  test("a `deleted` for a subscription the row does not hold cannot downgrade the workspace", async () => {
    mocks.subFindOne.mockReturnValue(chain(null));
    mocks.subUpdateOne.mockResolvedValueOnce({ matchedCount: 0, modifiedCount: 0, upsertedCount: 0 });

    const { status } = await post(subscriptionEvent("customer.subscription.deleted", { id: "sub_STALE", status: "canceled" }));

    expect(status).toBe(200);
    const [filter, update] = subWrites()[0];
    // Keyed by the subscription id itself, never by org: a stale id matches no row.
    expect(filter.stripeSubscriptionId).toBe("sub_STALE");
    expect(filter.orgId).toBeUndefined();
    expect(update.$set.status).toBe("free");
  });
});

describe("yearly Pro", () => {
  test("the annual price reads as Pro, the interval is stored, and nothing metered survives", async () => {
    // A row from a monthly past: on-demand on, a metered item id stored.
    mocks.subFindOne.mockReturnValue(chain({ orgId: ORG_ID, stripeSubscriptionId: "sub_A", status: "active" }));

    const { status } = await post(subscriptionEvent("customer.subscription.updated", { id: "sub_A", status: "active", interval: "year" }));

    expect(status).toBe(200);
    const [, update] = subWrites()[0];
    expect(update.$set.kind).toBe("pro");
    expect(update.$set.interval).toBe("year");
    expect(update.$set.stripeSubscriptionItemId).toBeNull();
    expect(mocks.grantCycleIncludedCredits).toHaveBeenCalledTimes(1);
    // On-demand switched off: yearly has no line item that could bill it.
    const offCall = (mocks.balanceUpdateOne.mock.calls as unknown as Array<[Record<string, any>, Record<string, any>]>).find(
      ([f, u]) => f?.onDemandEnabled === true && u?.$set?.onDemandEnabled === false,
    );
    expect(offCall).toBeDefined();
  });

  test("monthly Pro keeps its metered item id and its on-demand switch", async () => {
    mocks.subFindOne.mockReturnValue(chain({ orgId: ORG_ID, stripeSubscriptionId: "sub_A", status: "active" }));

    await post(subscriptionEvent("customer.subscription.updated", { id: "sub_A", status: "active", interval: "month" }));

    const [, update] = subWrites()[0];
    expect(update.$set.interval).toBe("month");
    expect(update.$set.stripeSubscriptionItemId).toBe("si_credits");
    const offCall = (mocks.balanceUpdateOne.mock.calls as unknown as Array<[Record<string, any>, Record<string, any>]>).find(
      ([, u]) => u?.$set?.onDemandEnabled === false,
    );
    expect(offCall).toBeUndefined();
  });
});

describe("Free daily brake", () => {
  /** The `updateOne` calls that touched the credit balance row, as `[filter, update]`. */
  const balanceWrites = () => mocks.balanceUpdateOne.mock.calls as unknown as Array<[Record<string, any>, Record<string, any>]>;
  const capRestore = () => balanceWrites().find(([, u]) => u?.$set?.dailyCreditCap === 15);
  const capLift = () => balanceWrites().find(([f, u]) => u?.$set?.dailyCreditCap === null && f?.dailyCreditCap !== undefined);

  test("restored when the subscription is deleted, unless purchased credits lifted it", async () => {
    mocks.subFindOne.mockReturnValue(chain({ orgId: ORG_ID, stripeSubscriptionId: "sub_A", status: "active" }));

    await post(subscriptionEvent("customer.subscription.deleted", { id: "sub_A", status: "canceled" }));

    const call = capRestore();
    expect(call).toBeDefined();
    const [filter] = call!;
    expect(filter.dailyCreditCap).toBeNull();
    expect(filter.$or).toEqual([{ purchasedCreditsRemaining: { $exists: false } }, { purchasedCreditsRemaining: { $lte: 0 } }]);
  });

  test("restored when the subscription lapses to past_due", async () => {
    mocks.subFindOne.mockReturnValue(chain({ orgId: ORG_ID, stripeSubscriptionId: "sub_A", status: "active" }));

    await post(subscriptionEvent("customer.subscription.updated", { id: "sub_A", status: "past_due" }));

    expect(capRestore()).toBeDefined();
    expect(capLift()).toBeUndefined();
    expect(mocks.grantCycleIncludedCredits).not.toHaveBeenCalled();
  });

  test("lifted again when the same subscription recovers to active", async () => {
    mocks.subFindOne.mockReturnValue(chain({ orgId: ORG_ID, stripeSubscriptionId: "sub_A", status: "past_due" }));

    await post(subscriptionEvent("customer.subscription.updated", { id: "sub_A", status: "active" }));

    expect(capLift()).toBeDefined();
    expect(capRestore()).toBeUndefined();
  });
});
