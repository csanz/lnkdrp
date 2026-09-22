/**
 * `GET /api/activity/summary` must measure the tiles, the donut and the chart over the SAME days.
 *
 * The window used to be a rolling `Date.now() - days * 24h`, an instant partway through the first
 * calendar day, while the per-day group keys rows by their UTC day and `buildActivitySeries` emits
 * `days` whole days ending today. Anything in that leading sliver was counted in `counts`/`actors`
 * and had no bucket to land in, so the header disagreed with the line beneath it and `since` named
 * a day the series did not contain. These tests pin the snapped bound.
 *
 * Mongo is stubbed by a tiny stand-in that filters the events on whatever `$match` the route sends
 * and then groups them the two ways the route asks for, so a wrong `since` shows up here the same
 * way it showed up in production: in the numbers, not only in the pipeline.
 */
import { beforeEach, afterEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId().toString();
const USER = new Types.ObjectId().toString();

const connectMongo = vi.fn(async () => undefined);
const aggregate = vi.fn();
const resolveActor = vi.fn(async () => ({ kind: "user", orgId: ORG, userId: USER }));
const applyTempUserHeaders = vi.fn((res: unknown) => res);
const requireOrgRole = vi.fn(async () => ({ ok: true }));

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: { aggregate } }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor, applyTempUserHeaders }));
vi.mock("@/lib/orgs/requireOrgRole", () => ({ requireOrgRole }));

const { GET } = await import("@/app/api/activity/summary/route");

/** Pinned "now": early morning UTC, so a rolling window would start mid-morning the day before. */
const NOW = new Date("2026-09-22T06:32:58.218Z");

type Event = { at: string; type: string; agent?: boolean };

/** Stand in for the two aggregations, honouring the `$match` the route built. */
function withEvents(events: readonly Event[]) {
  aggregate.mockImplementation((pipeline: Array<Record<string, unknown>>) => {
    const since = (pipeline.find((s) => s.$match) as { $match: { createdDate: { $gte: Date } } }).$match.createdDate.$gte;
    const kept = events.filter((e) => new Date(e.at).getTime() >= since.getTime());
    const perDay = JSON.stringify(pipeline).includes("$dateToString");
    const counts = new Map<string, { id: Record<string, unknown>; count: number }>();
    for (const e of kept) {
      const id = perDay
        ? { day: e.at.slice(0, 10), type: e.type, agent: e.agent === true }
        : { type: e.type, client: e.agent === true ? "claude-code" : null };
      const key = JSON.stringify(id);
      const prev = counts.get(key);
      counts.set(key, { id, count: (prev?.count ?? 0) + 1 });
    }
    return Promise.resolve(Array.from(counts.values()).map((c) => ({ _id: c.id, count: c.count })));
  });
}

function matchSince(): Date {
  const call = aggregate.mock.calls[0]?.[0] as Array<{ $match?: { createdDate?: { $gte?: Date } } }>;
  const since = call?.find((s) => s.$match)?.$match?.createdDate?.$gte;
  if (!(since instanceof Date)) throw new Error("no $match createdDate.$gte in the pipeline");
  return since;
}

async function summary(days: number) {
  const res = await GET(new Request(`http://localhost/api/activity/summary?days=${days}`));
  return (await res.json()) as {
    since: string;
    actors: { total: number };
    series: Array<{ day: string; total: number }>;
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  resolveActor.mockResolvedValue({ kind: "user", orgId: ORG, userId: USER });
  requireOrgRole.mockResolvedValue({ ok: true });
  withEvents([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("activity summary window", () => {
  test("since is midnight UTC of the window's first day, not a rolling instant", async () => {
    const json = await summary(30);
    expect(json.since).toBe("2026-08-24T00:00:00.000Z");
    expect(matchSince().toISOString()).toBe("2026-08-24T00:00:00.000Z");
    // The label has to name the first point of the series it labels.
    expect(json.series[0]?.day).toBe("2026-08-24");
    expect(json.series.at(-1)?.day).toBe("2026-09-22");
  });

  test("days=1 is today, so yesterday evening is outside the window rather than uncharted", async () => {
    // A rolling bound let 2026-09-21T20:00Z through the match (>= 2026-09-21T06:32Z) while the
    // chart only ever drew 2026-09-22: actors.total said 4, the line summed to 0.
    withEvents([
      { at: "2026-09-21T20:00:00.000Z", type: "doc.created" },
      { at: "2026-09-21T20:05:00.000Z", type: "doc.created" },
      { at: "2026-09-21T20:10:00.000Z", type: "doc.created" },
      { at: "2026-09-21T20:15:00.000Z", type: "doc.created" },
      { at: "2026-09-22T05:00:00.000Z", type: "share_link.created", agent: true },
    ]);
    const json = await summary(1);
    expect(json.since).toBe("2026-09-22T00:00:00.000Z");
    expect(json.series.map((p) => p.day)).toEqual(["2026-09-22"]);
    expect(json.actors.total).toBe(1);
    expect(json.series.reduce((sum, p) => sum + p.total, 0)).toBe(1);
  });

  test("the header total equals the chart's total across the window's leading edge", async () => {
    withEvents([
      // Before the snapped bound and before the rolling one: never counted either way.
      { at: "2026-08-22T23:00:00.000Z", type: "doc.created" },
      // In the sliver the rolling bound admitted and the chart had no bucket for.
      { at: "2026-08-23T20:00:00.000Z", type: "doc.created" },
      { at: "2026-08-24T09:00:00.000Z", type: "doc.created" },
      { at: "2026-09-22T05:00:00.000Z", type: "share_link.created", agent: true },
    ]);
    const json = await summary(30);
    const charted = json.series.reduce((sum, p) => sum + p.total, 0);
    expect(json.actors.total).toBe(2);
    expect(charted).toBe(json.actors.total);
  });
});
