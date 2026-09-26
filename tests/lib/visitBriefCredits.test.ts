/**
 * What a visit brief is allowed to cost, and who is allowed to make it cost that.
 *
 * Every test here pins a defect that charged a workspace for something it should never have paid
 * for, or let someone other than the workspace decide that it would:
 *
 * - The owner's own opens. The only owner test was a session-derived flag, so an owner or teammate
 *   reading their own link signed out was billed for a brief about themselves.
 * - The visit id is the caller's to invent, and every new one planted a row the cron billed. One
 *   forwarded slug could spend a Pro workspace's credits a credit at a time.
 * - The reservation was held across blob fetches and PDF extraction, so a function killed at its
 *   time limit left a live reservation behind.
 * - The credit was charged before the row was written, and a failed write cannot be refunded.
 * - A stale claim was retried under the same reservation key, so it got the dead run's ledger row.
 * - The hundred-a-day ceiling was a count read across a model call by three concurrent workers.
 *
 * And the behaviour that must survive all of it: a glance is free, Free workspaces are not billed,
 * a dry run takes nothing, and a workspace out of credits still gets the facts of the visit.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

// ---------------------------------------------------------------------------------------------
// A database small enough to reason about
// ---------------------------------------------------------------------------------------------

/** Mongoose's query builder, as much of it as this engine uses. */
function q(value: unknown) {
  const chain = {
    select: () => chain,
    sort: () => chain,
    limit: () => chain,
    lean: async () => value,
  };
  return chain;
}

type Bucket = { key: string; count: number; windowStart: Date; expiresAt: Date };
const buckets = new Map<string, Bucket>();

/** The subset of Mongo's filter language the two counters use. */
function matches(bucket: Bucket, filter: Record<string, unknown>): boolean {
  for (const [field, expected] of Object.entries(filter)) {
    const actual = (bucket as unknown as Record<string, unknown>)[field];
    if (expected && typeof expected === "object" && !(expected instanceof Date)) {
      const cond = expected as Record<string, unknown>;
      if ("$gt" in cond && !((actual as number) > (cond.$gt as number))) return false;
      if ("$lte" in cond && !((actual as number) <= (cond.$lte as number))) return false;
    } else if (String(actual) !== String(expected)) {
      return false;
    }
  }
  return true;
}

function applyUpdate(bucket: Bucket, update: Record<string, unknown>): void {
  const inc = update.$inc as Record<string, number> | undefined;
  if (inc?.count) bucket.count += inc.count;
  const set = update.$set as Record<string, unknown> | undefined;
  if (set) Object.assign(bucket, set);
}

const rateLimitModel = {
  findOneAndUpdate(filter: Record<string, unknown>, update: Record<string, unknown>, opts: { upsert?: boolean } = {}) {
    return {
      lean: async () => {
        const key = String(filter.key);
        const live = buckets.get(key);
        if (live && !matches(live, filter)) {
          // Real Mongo answers a non-matching upsert on a unique key with E11000.
          if (opts.upsert) throw Object.assign(new Error("E11000 duplicate key"), { code: 11000 });
          return null;
        }
        let bucket = live;
        if (!bucket) {
          if (!opts.upsert) return null;
          const init = (update.$setOnInsert ?? {}) as Partial<Bucket>;
          bucket = { key, count: Number(init.count ?? 0), windowStart: init.windowStart as Date, expiresAt: init.expiresAt as Date };
          buckets.set(key, bucket);
        }
        applyUpdate(bucket, update);
        return { ...bucket };
      },
    };
  },
  async updateOne(filter: Record<string, unknown>, update: Record<string, unknown>, opts: { upsert?: boolean } = {}) {
    const key = String(filter.key);
    const live = buckets.get(key);
    if (live && matches(live, filter)) {
      applyUpdate(live, update);
      return { matchedCount: 1, modifiedCount: 1 };
    }
    if (!live && opts.upsert) {
      const init = (update.$setOnInsert ?? {}) as Partial<Bucket>;
      const bucket: Bucket = { key, count: Number(init.count ?? 0), windowStart: init.windowStart as Date, expiresAt: init.expiresAt as Date };
      applyUpdate(bucket, update);
      buckets.set(key, bucket);
      return { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 };
    }
    return { matchedCount: 0, modifiedCount: 0 };
  },
};

const ORG = new Types.ObjectId();
const DOC = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const TEAMMATE = new Types.ObjectId();
const T0 = new Date("2026-09-23T10:00:00.000Z");
const NOW = new Date(T0.getTime() + 20 * 60_000);

/** Ordered trace of the calls whose ORDER is the fix, not just the fact that they happened. */
const order: string[] = [];

// ---- the engine's world ------------------------------------------------------------------------
/** What mongoose hands back from an `updateOne`, as much of it as this engine reads. */
type UpdateResult = { matchedCount: number; modifiedCount: number; upsertedCount?: number };
const visitBriefUpdateOne = vi.fn(
  async (_filter?: unknown, _update?: { $set?: Record<string, unknown> }, _opts?: { upsert?: boolean }): Promise<UpdateResult> => ({
    matchedCount: 1,
    modifiedCount: 1,
  }),
);
const visitBriefUpdateMany = vi.fn(async () => ({ modifiedCount: 1 }));
const briefsWrittenTodayCount = vi.fn(async () => 0);
const shareVisitRows = vi.fn(() => [] as unknown[]);
const docRows = vi.fn(() => [{ _id: DOC, title: "Series A deck", slideNodes: new Array(12).fill({}) }] as unknown[]);
const membershipExists = vi.fn(async () => null as unknown);
const userFindOne = vi.fn(() => q(null));
const orgFindById = vi.fn(() => q(null));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/VisitBrief", () => ({
  VISIT_BRIEF_STATUSES: [],
  VISIT_BRIEF_RECAP_REASONS: [],
  VisitBriefModel: {
    updateOne: (...args: unknown[]) => visitBriefUpdateOne(...(args as [])),
    updateMany: (...args: unknown[]) => visitBriefUpdateMany(...(args as [])),
    countDocuments: (...args: unknown[]) => briefsWrittenTodayCount(...(args as [])),
    find: () => q([]),
    findOne: () => q(null),
    findById: () => q(null),
    findOneAndUpdate: () => q(null),
  },
}));
vi.mock("@/lib/models/ShareVisit", () => ({
  ShareVisitModel: {
    find: (filter: Record<string, unknown>) => (filter?.visitIdHash && typeof filter.visitIdHash === "object" ? q([]) : q(shareVisitRows())),
  },
}));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { find: () => q([]) } }));
vi.mock("@/lib/models/ShareLink", () => ({ ShareLinkModel: { findOne: () => q(null) } }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { find: () => q(docRows()) } }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { findById: () => q(null) } }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findById: (...a: unknown[]) => orgFindById(...(a as [])) } }));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: {
    findOne: () => q({ userId: OWNER }),
    find: () => q([]),
    exists: (...a: unknown[]) => membershipExists(...(a as [])),
  },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: { findById: () => q(null), findOne: (...a: unknown[]) => userFindOne(...(a as [])) },
}));
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: { exists: async () => null } }));
vi.mock("@/lib/models/RateLimit", () => ({ RateLimitModel: rateLimitModel }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/share/projectPublic", () => ({ viewerKeyMatchClause: (h: string) => [{ botIdHash: h }] }));
vi.mock("@/lib/share/readerIdentity", () => ({
  loadShareViewIdentities: vi.fn(async () => []),
  pickReaderIdentity: vi.fn(() => ({})),
}));
vi.mock("@/lib/notifications/queue", () => ({
  enqueueNotifications: vi.fn(async () => undefined),
  notificationDedupeKey: (...parts: string[]) => parts.join(":"),
}));
vi.mock("@/lib/slack/outbox", () => ({ enqueueSlackPosts: vi.fn(async () => undefined), drainSlackOutbox: vi.fn(async () => undefined) }));
vi.mock("@/lib/notifications/sendNotificationEmails", () => ({ sendNotificationEmails: vi.fn(async () => null) }));

const workspacePlan = vi.fn(async () => "pro");
const aiAutomation = vi.fn(async () => ({ brief: true }));
vi.mock("@/lib/billing/planLimits", () => ({ getWorkspacePlan: (...a: unknown[]) => workspacePlan(...(a as [])) }));
vi.mock("@/lib/credits/aiAutomation", () => ({ getAiAutomation: (...a: unknown[]) => aiAutomation(...(a as [])) }));

const reserveCredits = vi.fn(async (p: { idempotencyKey: string }) => {
  order.push(`reserve:${p.idempotencyKey}`);
  return { ledgerId: String(new Types.ObjectId()), status: "reserved", creditsReserved: 1, creditsEstimated: 1 };
});
const markCharged = vi.fn(async () => {
  order.push("charge");
});
const refundLedger = vi.fn(async () => {
  order.push("refund");
});
vi.mock("@/lib/credits/creditService", () => ({
  reserveCreditsOrThrow: (...a: unknown[]) => reserveCredits(...(a as [never])),
  markLedgerCharged: (...a: unknown[]) => markCharged(...(a as [])),
  failAndRefundLedger: (...a: unknown[]) => refundLedger(...(a as [])),
}));

const pageOutline = vi.fn(async () => {
  order.push("outline");
  return null;
});
vi.mock("@/lib/visits/pageOutline", () => ({ getPageOutline: (...a: unknown[]) => pageOutline(...(a as [])) }));

const generateBrief = vi.fn(async () => {
  order.push("model");
  // A real model call is not instantaneous; the brake has to hold across this await.
  await new Promise((r) => setTimeout(r, 0));
  return {
    output: { headline: "Spent 5 min on pricing", body: "They read the pricing page twice.", interests: ["pricing"], highlights: [], followUp: null },
    telemetry: { provider: "openai" as const, modelRoute: "gpt-4o", promptTokens: 10, completionTokens: 10, totalTokens: 20, latencyMs: 5, retriesCount: 0 },
    aiRunId: String(new Types.ObjectId()),
  };
});
vi.mock("@/lib/ai/visitBrief", async (importOriginal) => {
  const real = (await importOriginal()) as Record<string, unknown>;
  return { ...real, generateVisitBrief: (...a: unknown[]) => generateBrief(...(a as [])) };
});

const {
  BRIEFS_PER_DAY,
  claimDailyBriefSlot,
  dailyBriefSlotKey,
  isOwnerSideSitting,
  recoverStaleVisitBriefClaims,
  settleVisitBrief,
} = await import("@/lib/visits/visitBriefs");
const { scheduleVisitBrief, NEW_SITTINGS_PER_LINK_PER_HOUR, newSittingBucketKey } = await import("@/lib/visits/scheduleVisitBrief");

// ---------------------------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------------------------

/** One `ShareVisit` of a real read: six minutes over four pages, well past the glance floor. */
function readVisit(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    docId: DOC,
    botIdHash: "b".repeat(64),
    visitIdHash: "v1",
    startedAt: T0,
    lastEventAt: new Date(T0.getTime() + 380_000),
    timeSpentMs: 380_000,
    pagesSeen: [1, 2, 3, 7],
    pageTimeMsByPage: { "1": 20_000, "2": 40_000, "3": 30_000, "7": 290_000 },
    pageVisitCountByPage: { "1": 1, "2": 1, "3": 2, "7": 1 },
    pageEvents: [],
    pageCount: 12,
    isOwnerPreview: false,
    ...overrides,
  };
}

/** A claimed `VisitBrief` row, as `claimDueVisitBriefs` hands it to `settleVisitBrief`. */
function claimedRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: new Types.ObjectId(),
    orgId: ORG,
    docId: DOC,
    projectId: null,
    shareId: "share-1",
    visitIdHash: "v1",
    botIdHash: "b".repeat(64),
    isOwnerPreview: false,
    viewerUserId: null,
    viewerName: null,
    viewerEmail: null,
    startedAt: T0,
    lastEventAt: new Date(T0.getTime() + 380_000),
    dueAt: new Date(T0.getTime() + 500_000),
    status: "generating",
    attempts: 0,
    claimToken: "tok",
    stats: null,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ...overrides,
  } as any;
}

beforeEach(() => {
  vi.clearAllMocks();
  buckets.clear();
  order.length = 0;
  shareVisitRows.mockReturnValue([readVisit()]);
  docRows.mockReturnValue([{ _id: DOC, title: "Series A deck", slideNodes: new Array(12).fill({}) }]);
  briefsWrittenTodayCount.mockResolvedValue(0);
  workspacePlan.mockResolvedValue("pro");
  aiAutomation.mockResolvedValue({ brief: true });
  membershipExists.mockResolvedValue(null);
  userFindOne.mockReturnValue(q(null));
  orgFindById.mockReturnValue(q(null));
  visitBriefUpdateOne.mockImplementation(async (_filter?: unknown, update?: { $set?: Record<string, unknown> }) => {
    if (update?.$set?.status === "briefed") order.push("write:briefed");
    return { matchedCount: 1, modifiedCount: 1 };
  });
});

/** The fields of the last `finish()` write, so a test can see what the row was left as. */
function lastWrite(): Record<string, unknown> {
  const call = visitBriefUpdateOne.mock.calls.at(-1) as unknown as [unknown, { $set?: Record<string, unknown> }];
  return call?.[1]?.$set ?? {};
}

// ---------------------------------------------------------------------------------------------

describe("the owner's own opens are free, session or no session", () => {
  test("a teammate reading their own link signed out is not billed for a brief about themselves", async () => {
    // No session anywhere: the ingest never set `isOwnerPreview`. All we have is the address they
    // typed into the introduce-yourself gate, and it belongs to a member of the owning workspace.
    userFindOne.mockReturnValue(q({ _id: TEAMMATE }));
    membershipExists.mockResolvedValue({ _id: new Types.ObjectId() });

    const res = await settleVisitBrief(claimedRow({ viewerEmail: "teammate@acme.com" }), { now: NOW });

    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("owner_preview");
    expect(res.creditsCharged).toBe(0);
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateBrief).not.toHaveBeenCalled();
    expect(lastWrite().recapReason).toBe("owner_preview");
  });

  test("the account id is checked the same way, for a sitting that carries one without a flag", async () => {
    membershipExists.mockResolvedValue({ _id: new Types.ObjectId() });
    const res = await settleVisitBrief(claimedRow({ viewerUserId: TEAMMATE }), { now: NOW });
    expect(res.reason).toBe("owner_preview");
    expect(reserveCredits).not.toHaveBeenCalled();
  });

  test("a recipient who has an account elsewhere is still a recipient, and still gets a brief", async () => {
    // The address resolves to a user, but that user is in nobody's workspace here.
    userFindOne.mockReturnValue(q({ _id: new Types.ObjectId() }));
    membershipExists.mockResolvedValue(null);

    const res = await settleVisitBrief(claimedRow({ viewerEmail: "investor@fund.com" }), { now: NOW });

    expect(res.outcome).toBe("briefed");
    expect(res.creditsCharged).toBe(1);
  });

  test("an anonymous signed-out reader is treated as a recipient, which is the honest answer", async () => {
    // Nothing to match on. The hole is narrowed to "signed out AND anonymous", not closed, and
    // guessing owner here would silence the feature for the people it exists for.
    expect(await isOwnerSideSitting({ orgId: ORG, flagged: false })).toBe(false);
    expect(userFindOne).not.toHaveBeenCalled();
  });

  test("the ingest's flag still decides on its own, without a lookup", async () => {
    expect(await isOwnerSideSitting({ orgId: ORG, flagged: true, viewerEmail: "someone@else.com" })).toBe(true);
    expect(userFindOne).not.toHaveBeenCalled();
    expect(membershipExists).not.toHaveBeenCalled();
  });

  test("a lookup that fails reads as a recipient, never as a dropped visit", async () => {
    userFindOne.mockImplementation(() => {
      throw new Error("mongo down");
    });
    expect(await isOwnerSideSitting({ orgId: ORG, flagged: false, viewerEmail: "teammate@acme.com" })).toBe(false);
  });
});

describe("a stranger with the slug cannot mint billable sittings", () => {
  const ingest = (visitIdHash: string, at = T0) =>
    scheduleVisitBrief({
      orgId: ORG,
      docId: DOC,
      shareId: "share-1",
      visitIdHash,
      botIdHash: "b".repeat(64),
      isOwnerPreview: false,
      at,
    });

  test("one link opens at most the hour's allowance of new sittings, whatever visit ids are posted", async () => {
    // Nothing exists yet, so every post is a would-be new row.
    visitBriefUpdateOne.mockImplementation(async (_filter?: unknown, _update?: unknown, opts?: { upsert?: boolean }) =>
      opts?.upsert ? { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 } : { matchedCount: 0, modifiedCount: 0 },
    );

    for (let i = 0; i < NEW_SITTINGS_PER_LINK_PER_HOUR + 12; i += 1) await ingest(`forged-${i}`);

    const upserts = visitBriefUpdateOne.mock.calls.filter((c) => (c as unknown as [unknown, unknown, { upsert?: boolean }])[2]?.upsert);
    expect(upserts).toHaveLength(NEW_SITTINGS_PER_LINK_PER_HOUR);
    expect(buckets.get(newSittingBucketKey("share-1"))?.count).toBeGreaterThan(NEW_SITTINGS_PER_LINK_PER_HOUR);
  });

  test("the bound is per link, so a busy link cannot starve a quiet one", async () => {
    visitBriefUpdateOne.mockImplementation(async () => ({ matchedCount: 0, modifiedCount: 0 }));
    for (let i = 0; i < NEW_SITTINGS_PER_LINK_PER_HOUR + 5; i += 1) await ingest(`forged-${i}`);
    visitBriefUpdateOne.mockClear();

    await scheduleVisitBrief({
      orgId: ORG,
      docId: DOC,
      shareId: "share-2",
      visitIdHash: "real",
      botIdHash: "c".repeat(64),
      isOwnerPreview: false,
      at: T0,
    });
    expect(visitBriefUpdateOne.mock.calls.some((c) => (c as unknown as [unknown, unknown, { upsert?: boolean }])[2]?.upsert)).toBe(true);
  });

  test("a sitting that already exists keeps its clock moving past the bound: only NEW rows are counted", async () => {
    visitBriefUpdateOne.mockImplementation(async () => ({ matchedCount: 0, modifiedCount: 0 }));
    for (let i = 0; i < NEW_SITTINGS_PER_LINK_PER_HOUR + 3; i += 1) await ingest(`forged-${i}`);
    const spent = buckets.get(newSittingBucketKey("share-1"))!.count;

    // The real recipient's tab, already on the books: the update matches and returns.
    visitBriefUpdateOne.mockImplementation(async () => ({ matchedCount: 1, modifiedCount: 1 }));
    visitBriefUpdateOne.mockClear();
    await ingest("a-real-open");

    expect(visitBriefUpdateOne).toHaveBeenCalledTimes(1);
    expect(buckets.get(newSittingBucketKey("share-1"))!.count).toBe(spent);
  });

  test("the hour turns over and the link can open sittings again", async () => {
    visitBriefUpdateOne.mockImplementation(async (_f?: unknown, _u?: unknown, opts?: { upsert?: boolean }) =>
      opts?.upsert ? { matchedCount: 0, modifiedCount: 0, upsertedCount: 1 } : { matchedCount: 0, modifiedCount: 0 },
    );
    for (let i = 0; i < NEW_SITTINGS_PER_LINK_PER_HOUR + 5; i += 1) await ingest(`forged-${i}`);
    visitBriefUpdateOne.mockClear();

    await ingest("next-hour", new Date(T0.getTime() + 61 * 60_000));
    expect(visitBriefUpdateOne.mock.calls.some((c) => (c as unknown as [unknown, unknown, { upsert?: boolean }])[2]?.upsert)).toBe(true);
  });
});

describe("the reservation is held for the model call and nothing else", () => {
  test("the per-document outline work happens before a credit is reserved", async () => {
    await settleVisitBrief(claimedRow(), { now: NOW });
    const outlineAt = order.indexOf("outline");
    const reserveAt = order.findIndex((o) => o.startsWith("reserve:"));
    expect(outlineAt).toBeGreaterThanOrEqual(0);
    expect(reserveAt).toBeGreaterThan(outlineAt);
    expect(order.indexOf("model")).toBeGreaterThan(reserveAt);
  });

  test("an outline that fails never held a credit, so there is nothing to refund", async () => {
    pageOutline.mockRejectedValueOnce(new Error("blob fetch timed out"));
    const res = await settleVisitBrief(claimedRow(), { now: NOW });
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(refundLedger).not.toHaveBeenCalled();
    expect(res.creditsCharged).toBe(0);
    expect(res.outcome).toBe("retry");
  });
});

describe("the credit is charged for a brief that exists", () => {
  test("the row is written first, then the ledger is charged", async () => {
    await settleVisitBrief(claimedRow(), { now: NOW });
    expect(order.filter((o) => o === "charge")).toHaveLength(1);
    const writeAt = order.indexOf("write:briefed");
    expect(writeAt).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("charge")).toBeGreaterThan(writeAt);
  });

  test("a write that fails refunds the reservation instead of charging for a brief nobody has", async () => {
    visitBriefUpdateOne.mockImplementation(async (_filter?: unknown, update?: { $set?: Record<string, unknown> }) => {
      if (update?.$set?.status === "briefed") throw new Error("write concern failed");
      return { matchedCount: 1, modifiedCount: 1 };
    });

    const res = await settleVisitBrief(claimedRow(), { now: NOW });

    expect(markCharged).not.toHaveBeenCalled();
    expect(refundLedger).toHaveBeenCalledTimes(1);
    expect(res.creditsCharged).toBe(0);
    expect(res.outcome).toBe("retry");
  });

  test("a briefed write that lands on no row refunds instead of charging, though Mongo never threw", async () => {
    // The stale sweeper stole the claim while the model was running. A filter that matches nothing
    // is not an error in Mongo: the write answers `matchedCount: 0` and resolves. Only the result
    // says the brief was never stored, so a `finish` that ignored it charged for nothing.
    visitBriefUpdateOne.mockImplementation(async (_filter?: unknown, update?: { $set?: Record<string, unknown> }) => {
      if (update?.$set?.status === "briefed") {
        order.push("write:missed");
        return { matchedCount: 0, modifiedCount: 0 };
      }
      return { matchedCount: 1, modifiedCount: 1 };
    });

    const res = await settleVisitBrief(claimedRow(), { now: NOW });

    expect(order).toContain("write:missed");
    expect(markCharged).not.toHaveBeenCalled();
    expect(refundLedger).toHaveBeenCalledTimes(1);
    expect(res.outcome).not.toBe("briefed");
    expect(res.creditsCharged).toBe(0);
    // And the day's slot is not spent on a brief nobody has.
    expect(buckets.get(dailyBriefSlotKey(ORG, NOW))?.count).toBe(0);
  });

  test("a charge that fails after the brief is stored keeps the brief and reports no credit taken", async () => {
    markCharged.mockRejectedValueOnce(new Error("ledger unavailable"));
    const res = await settleVisitBrief(claimedRow(), { now: NOW });
    expect(res.outcome).toBe("briefed");
    expect(res.creditsCharged).toBe(0);
    expect(refundLedger).not.toHaveBeenCalled();
  });
});

describe("every attempt reserves under a key of its own", () => {
  test("recovering a stale claim bumps attempts, so the retry cannot be handed the dead run's ledger row", async () => {
    await recoverStaleVisitBriefClaims({ now: NOW });
    const [, update] = visitBriefUpdateMany.mock.calls.at(-1) as unknown as [unknown, Record<string, Record<string, unknown>>];
    expect(update.$set.status).toBe("scheduled");
    expect(update.$inc).toEqual({ attempts: 1 });
  });

  test("the reservation key carries the attempt, so the bumped row asks for a fresh reservation", async () => {
    await settleVisitBrief(claimedRow({ attempts: 0 }), { now: NOW });
    const first = reserveCredits.mock.calls.at(-1)![0] as { idempotencyKey: string };
    reserveCredits.mockClear();
    await settleVisitBrief(claimedRow({ attempts: 1 }), { now: NOW });
    const second = reserveCredits.mock.calls.at(-1)![0] as { idempotencyKey: string };

    expect(first.idempotencyKey).toMatch(/:0$/);
    expect(second.idempotencyKey).toMatch(/:1$/);
    expect(first.idempotencyKey).not.toBe(second.idempotencyKey);
  });
});

describe("the hundred-a-day brake holds", () => {
  test("three workers settling at once cannot take the ceiling past its last slot", async () => {
    // Ninety-nine written today and three rows due. The old brake read 99 three times, before any
    // of the three model calls returned, and let all three through.
    briefsWrittenTodayCount.mockResolvedValue(BRIEFS_PER_DAY - 1);

    const results = await Promise.all([claimedRow(), claimedRow(), claimedRow()].map((r) => settleVisitBrief(r, { now: NOW })));

    expect(results.filter((r) => r.outcome === "briefed")).toHaveLength(1);
    expect(results.filter((r) => r.outcome === "recap" && r.reason === "daily_cap")).toHaveLength(2);
    expect(reserveCredits).toHaveBeenCalledTimes(1);
  });

  test("the day's bucket starts at the briefs already stored, so a fresh bucket grants nothing back", async () => {
    briefsWrittenTodayCount.mockResolvedValue(BRIEFS_PER_DAY - 1);
    expect(await claimDailyBriefSlot({ orgId: ORG, now: NOW })).toBe(true);
    expect(await claimDailyBriefSlot({ orgId: ORG, now: NOW })).toBe(false);
    expect(buckets.get(dailyBriefSlotKey(ORG, NOW))?.count).toBe(BRIEFS_PER_DAY);
  });

  test("a slot taken by an attempt that wrote nothing goes back to the day", async () => {
    reserveCredits.mockRejectedValueOnce(Object.assign(new Error("insufficient credits"), { code: "OUT_OF_CREDITS" }));
    const res = await settleVisitBrief(claimedRow(), { now: NOW });
    expect(res.outcome).toBe("recap");
    expect(buckets.get(dailyBriefSlotKey(ORG, NOW))?.count).toBe(0);
  });

  test("a reservation that fails on infrastructure gives the slot back on its way out", async () => {
    // Not out of credits and not the daily cap: `generateAndStoreBrief` rethrows anything else, so
    // the throw leaves `settleVisitBrief` without touching the release calls on the return paths.
    // One of these per row per minute used to burn the workspace's whole day in under two hours.
    reserveCredits.mockRejectedValueOnce(new Error("connection timed out"));

    await expect(settleVisitBrief(claimedRow(), { now: NOW })).rejects.toThrow("connection timed out");

    expect(buckets.get(dailyBriefSlotKey(ORG, NOW))?.count).toBe(0);
  });

  test("a brake that cannot be read refuses rather than waving everything through", async () => {
    briefsWrittenTodayCount.mockRejectedValueOnce(new Error("mongo down"));
    expect(await claimDailyBriefSlot({ orgId: ORG, now: NOW })).toBe(false);
  });
});

describe("what a visit brief still never costs", () => {
  test("a glance is skipped: under twenty seconds on one page takes no slot and no credit", async () => {
    shareVisitRows.mockReturnValue([readVisit({ timeSpentMs: 6_000, pagesSeen: [1], pageTimeMsByPage: { "1": 6_000 }, pageVisitCountByPage: { "1": 1 } })]);
    const res = await settleVisitBrief(claimedRow(), { now: NOW });
    expect(res.outcome).toBe("skipped");
    expect(res.reason).toBe("below_minimum");
    expect(res.creditsCharged).toBe(0);
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(buckets.get(dailyBriefSlotKey(ORG, NOW))).toBeUndefined();
  });

  test("a skim over two pages is not a glance, and does get its brief", async () => {
    shareVisitRows.mockReturnValue([readVisit({ timeSpentMs: 9_000, pagesSeen: [1, 2], pageTimeMsByPage: { "1": 5_000, "2": 4_000 }, pageVisitCountByPage: { "1": 1, "2": 1 } })]);
    expect((await settleVisitBrief(claimedRow(), { now: NOW })).outcome).toBe("briefed");
  });

  test("a Free workspace is never billed and never reserves", async () => {
    workspacePlan.mockResolvedValue("free");
    const res = await settleVisitBrief(claimedRow(), { now: NOW });
    expect(res.reason).toBe("plan");
    expect(res.creditsCharged).toBe(0);
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(generateBrief).not.toHaveBeenCalled();
    // The facts are frozen on the row all the same, so nothing about the visit is lost.
    expect(lastWrite().stats).toBeTruthy();
  });

  test("out of credits still gets the facts of the visit, without the write-up", async () => {
    reserveCredits.mockRejectedValueOnce(Object.assign(new Error("insufficient credits"), { code: "OUT_OF_CREDITS" }));
    const res = await settleVisitBrief(claimedRow(), { now: NOW });
    expect(res.outcome).toBe("recap");
    expect(res.reason).toBe("out_of_credits");
    expect(res.creditsCharged).toBe(0);
    expect(lastWrite().stats).toBeTruthy();
    expect(lastWrite().status).toBe("recap");
  });

  test("automatic briefs switched off costs nothing and takes no slot", async () => {
    aiAutomation.mockResolvedValue({ brief: false });
    const res = await settleVisitBrief(claimedRow(), { now: NOW });
    expect(res.reason).toBe("auto_off");
    expect(buckets.get(dailyBriefSlotKey(ORG, NOW))).toBeUndefined();
  });

  test("a dry run takes no slot, no reservation and no credit", async () => {
    const res = await settleVisitBrief(claimedRow(), { now: NOW, dryRun: true });
    expect(res.outcome).toBe("briefed");
    expect(res.creditsCharged).toBe(0);
    expect(reserveCredits).not.toHaveBeenCalled();
    expect(visitBriefUpdateOne).not.toHaveBeenCalled();
    expect(buckets.get(dailyBriefSlotKey(ORG, NOW))).toBeUndefined();
  });
});
