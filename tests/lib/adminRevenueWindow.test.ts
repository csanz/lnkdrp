/**
 * `/api/admin/revenue`: the day the window opens on is one UTC day but two windows.
 *
 * `since` is an instant (`now - days * 24h`), while the aggregations bucket by UTC day, so the
 * boundary day emits one group for the charges older than `since` and one for the charges inside
 * it. Folding those two groups together put pre-window money in the "Charged, {days}d" tile and
 * took it out of the previous window at the same time, moving the same cents into the numerator
 * and out of the denominator of the trend. These tests pin both halves of that boundary day.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { connectMongo, purchaseAggregate, ledgerAggregate, subFind, orgCount, billingFindOne, requireAdmin } = vi.hoisted(() => ({
  connectMongo: vi.fn(async () => undefined),
  purchaseAggregate: vi.fn(),
  ledgerAggregate: vi.fn(),
  subFind: vi.fn(),
  orgCount: vi.fn(),
  billingFindOne: vi.fn(),
  requireAdmin: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/gating/requireAdmin", () => ({ requireAdmin }));
vi.mock("@/lib/models/CreditPurchase", () => ({ CreditPurchaseModel: { aggregate: purchaseAggregate } }));
vi.mock("@/lib/models/CreditLedger", () => ({ CreditLedgerModel: { aggregate: ledgerAggregate } }));
vi.mock("@/lib/models/Subscription", () => ({ SubscriptionModel: { find: subFind } }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { countDocuments: orgCount } }));
vi.mock("@/lib/models/BillingConfig", () => ({ BillingConfigModel: { findOne: billingFindOne } }));

const { GET } = await import("@/app/api/admin/revenue/route");

/** Frozen so "30 days ago" lands mid-afternoon, which is what splits a UTC day in two. */
const NOW = new Date("2026-09-22T14:00:00Z");
/** 2026-08-23T14:00Z: the boundary instant for days=30. */
const BOUNDARY_DAY = "2026-08-23";

type Pipeline = Record<string, any>[];

/**
 * Group the fixture rows the way Mongo would group them for the pipeline the route actually sent,
 * so the test cannot drift away from the route's own window arithmetic. A pipeline whose group key
 * carries no `recent` flag buckets by UTC day alone, which is exactly what the route used to ask
 * for and what these tests are here to catch.
 */
function boundaries(pipeline: Pipeline, field: string) {
  const prevSince = pipeline[0].$match?.[field]?.$gte as Date;
  expect(prevSince, `${field} pipeline should match from prevSince`).toBeInstanceOf(Date);
  const groupId = pipeline[1].$group?._id;
  const recent = groupId && typeof groupId === "object" ? (groupId as Record<string, any>).recent : undefined;
  return { prevSince, since: recent?.$gte?.[1] as Date | undefined };
}

function dayKey(at: Date) {
  return at.toISOString().slice(0, 10);
}

function groupPurchases(pipeline: Pipeline, rows: { at: Date; cents: number }[]) {
  const { prevSince, since } = boundaries(pipeline, "purchasedAt");
  const out = new Map<string, { _id: string; recent?: boolean; cents: number; count: number }>();
  for (const row of rows) {
    if (row.at < prevSince) continue;
    const recent = since ? row.at >= since : undefined;
    const key = `${dayKey(row.at)}|${recent}`;
    const cur = out.get(key) ?? { _id: dayKey(row.at), ...(recent === undefined ? {} : { recent }), cents: 0, count: 0 };
    cur.cents += row.cents;
    cur.count += 1;
    out.set(key, cur);
  }
  return [...out.values()];
}

function groupLedger(pipeline: Pipeline, rows: { at: Date; credits: number }[]) {
  const { prevSince, since } = boundaries(pipeline, "createdDate");
  const out = new Map<string, { _id: string; recent?: boolean; credits: number }>();
  for (const row of rows) {
    if (row.at < prevSince) continue;
    const recent = since ? row.at >= since : undefined;
    const key = `${dayKey(row.at)}|${recent}`;
    const cur = out.get(key) ?? { _id: dayKey(row.at), ...(recent === undefined ? {} : { recent }), credits: 0 };
    cur.credits += row.credits;
    out.set(key, cur);
  }
  return [...out.values()];
}

async function revenue(days: number) {
  const res = await GET(new Request(`https://lnkdrp.test/api/admin/revenue?days=${days}`));
  return (await res.json()) as {
    since: string;
    summary: { packCents: number; onDemandCents: number; chargedCents: number; previousChargedCents: number; trendPct: number | null; packCount: number };
    series: { day: string; packCents: number; onDemandCents: number }[];
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  requireAdmin.mockResolvedValue({ ok: true });
  subFind.mockReturnValue({ select: () => ({ limit: () => ({ lean: async () => [] }) }) });
  orgCount.mockResolvedValue(0);
  billingFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
  ledgerAggregate.mockImplementation(async (pipeline: Pipeline) => groupLedger(pipeline, []));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the boundary day is split at `since`, not swallowed whole", () => {
  test("a pack bought before `since` on the boundary day belongs to the previous window", async () => {
    purchaseAggregate.mockImplementation(async (pipeline: Pipeline) =>
      groupPurchases(pipeline, [
        { at: new Date("2026-08-23T02:00:00Z"), cents: 5000 }, // 12h before `since`, same UTC day
        { at: new Date("2026-08-23T20:00:00Z"), cents: 2000 }, // 6h after `since`
      ]),
    );

    const body = await revenue(30);

    expect(body.since).toBe("2026-08-23T14:00:00.000Z");
    expect(body.summary.packCents).toBe(2000);
    expect(body.summary.chargedCents).toBe(2000);
    expect(body.summary.previousChargedCents).toBe(5000);
    expect(body.summary.packCount).toBe(1);
    expect(body.summary.trendPct).toBe(-60);
    // The chart's opening bucket is the in-window part of that day, matching the tile above it.
    expect(body.series[0]).toEqual({ day: BOUNDARY_DAY, packCents: 2000, onDemandCents: 0 });
  });

  test("metered on-demand usage is split at the same instant", async () => {
    purchaseAggregate.mockImplementation(async (pipeline: Pipeline) => groupPurchases(pipeline, []));
    ledgerAggregate.mockImplementation(async (pipeline: Pipeline) =>
      groupLedger(pipeline, [
        { at: new Date("2026-08-23T03:00:00Z"), credits: 10 }, // before `since`
        { at: new Date("2026-08-23T18:00:00Z"), credits: 5 }, // after `since`
      ]),
    );

    const body = await revenue(30);

    expect(body.summary.onDemandCents).toBe(50);
    expect(body.summary.chargedCents).toBe(50);
    expect(body.summary.previousChargedCents).toBe(100);
    expect(body.series[0]).toEqual({ day: BOUNDARY_DAY, packCents: 0, onDemandCents: 50 });
  });

  test("a whole day inside the window is untouched, and the days before it still fill", async () => {
    purchaseAggregate.mockImplementation(async (pipeline: Pipeline) =>
      groupPurchases(pipeline, [
        { at: new Date("2026-09-01T09:00:00Z"), cents: 1500 },
        { at: new Date("2026-09-01T23:30:00Z"), cents: 500 },
        { at: new Date("2026-08-01T09:00:00Z"), cents: 900 }, // squarely in the previous window
      ]),
    );

    const body = await revenue(30);

    expect(body.summary.packCents).toBe(2000);
    expect(body.summary.packCount).toBe(2);
    expect(body.summary.previousChargedCents).toBe(900);
    expect(body.series.find((d) => d.day === "2026-09-01")).toEqual({ day: "2026-09-01", packCents: 2000, onDemandCents: 0 });
    expect(body.series.every((d) => d.day >= BOUNDARY_DAY)).toBe(true);
  });
});
