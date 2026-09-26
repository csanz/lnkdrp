/**
 * The per-link ranking of `GET /api/docs/:docId/shareviews?byLink=1` has to be a fact about the
 * document, not about the order Mongo happened to read the rows in.
 *
 * It was not. The `$facet` ranked with `{ $sort: { views: -1 } }` and `{ $sort: { lastSeen: -1 } }`
 * and nothing else, `perLinkGroupStages` projects `_id: 0` so no unique key survived into the
 * facet, and a `$sort` + `$limit` top-k is not stable — so among links with equal `views` the
 * `$limit` kept an arbitrary one. Six identical requests for `topLinks=3` on one seeded document
 * came back three different ways, and at `topLinks=1` the *length* of the response moved between
 * one and two rows, because `byRecent` deduped into `byViews` only on some of the calls. The
 * top-links card named a different winner on refresh (`MetricsView` asks for `topLinks=5` on every
 * render) and an agent asking which link performed best got a different answer each time it asked.
 *
 * The Node-side `.sort((a, b) => b.views - a.views)` after the joins had the same hole: `Array.sort`
 * is stable, so equal-view rows simply kept whatever order the aggregate handed back.
 *
 * No database here. Mongo's instability is modelled the only way it can be from the outside: the
 * aggregate mock permutes its rows before applying the pipeline's own `$sort` spec, so a sort key
 * that is not a total order lets the permutation reach the response — which is exactly what an
 * unstable top-k does. A response that is identical under every permutation is one whose ranking
 * the sort keys, and nothing else, decided.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Everything the `vi.mock` factories touch lives here: those factories run while the route module
 * is imported, which is before any `const` in this file has been initialised.
 */
const fx = vi.hoisted(() => {
  const DOC_ID = "6ab20688d7e47b3f56a11aa7";
  const ORG_ID = "6ab20688d7e47b3f56a11bb8";
  const USER_ID = "6ab20688d7e47b3f56a11cc9";

  type Row = { shareId: string; views: number; viewers: number; pagesViewed: number; lastSeen: Date };
  const at = (hoursAgo: number) => new Date(Date.UTC(2026, 8, 20, 12, 0, 0) - hoursAgo * 3_600_000);

  /**
   * The shape the live reproduction had: two links tied on `views`, three tied one below them, and
   * the most recent link one of the tied pair — which is what made the row *count* move, and not
   * just the order.
   */
  const ROWS: Row[] = [
    { shareId: "WRdKDLq0IvNe", views: 2, viewers: 2, pagesViewed: 9, lastSeen: at(3) },
    { shareId: "pOu7rJLzNOxL", views: 2, viewers: 2, pagesViewed: 7, lastSeen: at(1) },
    { shareId: "WqSMXbt8zZTU", views: 1, viewers: 1, pagesViewed: 4, lastSeen: at(2) },
    { shareId: "62OJLDR4NWIn", views: 1, viewers: 1, pagesViewed: 3, lastSeen: at(5) },
    { shareId: "E3FgZ594yOfl", views: 1, viewers: 1, pagesViewed: 2, lastSeen: at(4) },
  ];
  const LABELS: Record<string, string> = {
    WRdKDLq0IvNe: "Probe expiring",
    pOu7rJLzNOxL: "Sequoia",
    WqSMXbt8zZTU: "Index",
    "62OJLDR4NWIn": "Accel",
    E3FgZ594yOfl: "Vertex security",
  };

  /** Which permutation of `ROWS` the next aggregate sees: "whatever order Mongo read them in". */
  const state = { order: [0, 1, 2, 3, 4] };
  const permuted = () => state.order.map((i) => ROWS[i]);

  function compareBy(spec: Record<string, number>) {
    return (a: Record<string, unknown>, b: Record<string, unknown>): number => {
      for (const [field, dir] of Object.entries(spec)) {
        const read = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === "number" ? v : String(v ?? ""));
        const av = read(a[field]);
        const bv = read(b[field]);
        const cmp = typeof av === "string" || typeof bv === "string" ? String(av).localeCompare(String(bv)) : av - bv;
        if (cmp !== 0) return dir < 0 ? -cmp : cmp;
      }
      return 0;
    };
  }

  /** The per-link `$group`/`$project` chain, recognised by the alias only it produces. */
  const isPerLinkPipeline = (stages: Array<Record<string, any>>) => stages.some((s) => s?.$project?.shareId === "$_id");

  async function aggregate(stages: Array<Record<string, any>>) {
    if (!isPerLinkPipeline(stages)) return [];
    const facet = stages.find((s) => s?.$facet)?.$facet as Record<string, Array<Record<string, any>>> | undefined;
    if (!facet) return permuted();
    const out: Record<string, Row[]> = {};
    for (const [branch, branchStages] of Object.entries(facet)) {
      // A stable sort over a permuted input is an unstable sort: ties come out in input order.
      const sort = branchStages.find((s) => s?.$sort)?.$sort as Record<string, number>;
      const limit = branchStages.find((s) => typeof s?.$limit === "number")?.$limit as number;
      out[branch] = [...permuted()].sort(compareBy(sort)).slice(0, limit);
    }
    return [out];
  }

  return { DOC_ID, ORG_ID, USER_ID, ROWS, LABELS, state, aggregate };
});

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/db/mongoRequestLogger", () => ({
  withMongoRequestLogging: (_req: unknown, fn: () => Promise<unknown>) => fn(),
}));
vi.mock("@/lib/gating/actor", () => {
  const actor = { userId: fx.USER_ID, orgId: fx.ORG_ID, personalOrgId: fx.ORG_ID };
  return {
    resolveActor: async () => actor,
    tryResolveUserActorFast: async () => actor,
    applyTempUserHeaders: (res: unknown) => res,
  };
});
vi.mock("@/lib/billing/planLimits", () => ({
  analyticsTierForPlan: () => "deep",
  clampAnalyticsDays: (_plan: unknown, days: number) => days,
  getWorkspacePlan: async () => "pro",
  limitsForPlan: () => ({ analyticsDays: 365 }),
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: () => ({ select: () => ({ lean: async () => ({ _id: fx.DOC_ID, orgId: fx.ORG_ID, title: "Series A deck" }) }) }),
  },
}));
vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: { aggregate: (stages: Array<Record<string, any>>) => fx.aggregate(stages), countDocuments: async () => 0 },
}));
vi.mock("@/lib/models/ShareVisit", () => ({
  ShareVisitModel: { aggregate: async () => [], countDocuments: async () => 0 },
}));
vi.mock("@/lib/models/ShareLink", () => ({
  PROJECT_LINK_FILTER: {},
  ShareLinkModel: {
    find: () => ({
      select: () => ({
        lean: async () => fx.ROWS.map((r) => ({ shareId: r.shareId, label: fx.LABELS[r.shareId], isDefault: false })),
      }),
      distinct: async () => fx.ROWS.map((r) => r.shareId),
    }),
    findOne: () => ({ lean: async () => null, select: () => ({ lean: async () => null }) }),
    exists: async () => null,
    countDocuments: async () => fx.ROWS.length,
  },
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) } }));
// No locked rooms, so the exclusion is inert and the ranking below is exactly what it always was.
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) } }));
vi.mock("@/lib/analytics/docScope", () => ({ docOnlyShareIdMatch: async () => ({ foreignShareIds: [], match: {} }) }));
vi.mock("@/lib/share/links", () => ({ toShareLinkDTO: (l: unknown) => l }));
vi.mock("@/lib/analytics/workspace/shape", () => ({ projectLinkMetricsHref: () => null }));
vi.mock("@/lib/share/projectPublic", () => ({
  splitProjectViewerKey: () => ({ botIdHash: "" }),
  viewerKeyMatchClause: () => [],
}));

import { GET } from "@/app/api/docs/[docId]/shareviews/route";

type ByLinkRow = { shareId: string; label?: string | null; views: number };

async function byLinkFor(query: string, order: number[]): Promise<ByLinkRow[]> {
  fx.state.order = order;
  const res = (await GET(new Request(`https://lnkdrp.test/api/docs/${fx.DOC_ID}/shareviews?${query}`), {
    params: Promise.resolve({ docId: fx.DOC_ID }),
  })) as Response;
  const body = (await res.json()) as { byLink?: ByLinkRow[]; error?: string };
  // A missing mock surfaces as this route's catch-all 400, which would otherwise read as "no rows".
  expect(body.error).toBeUndefined();
  return body.byLink ?? [];
}

/** Every rotation of the five rows: five different orders the same document could arrive in. */
const ORDERS = [0, 1, 2, 3, 4].map((shift) => [0, 1, 2, 3, 4].map((i) => (i + shift) % 5));

/** The same request, five times, as a caller refreshing a card would issue it. */
async function everyOrder(query: string): Promise<ByLinkRow[][]> {
  const answers: ByLinkRow[][] = [];
  for (const order of ORDERS) answers.push(await byLinkFor(query, order));
  return answers;
}

beforeEach(() => {
  fx.state.order = [0, 1, 2, 3, 4];
});

describe("byLink ranking is decided by the sort keys, not by row order", () => {
  test("topLinks=1 returns the same rows however the tied links reach the $facet", async () => {
    // The live symptom at its sharpest: the response *length* moved, because `byRecent` deduped
    // into `byViews` only when the top-by-views coin landed on the most recent link.
    const answers = await everyOrder("days=30&lite=1&byLink=1&topLinks=1");
    for (const rows of answers) expect(rows.map((r) => r.shareId)).toEqual(answers[0].map((r) => r.shareId));
    // The tie on `views` is broken by recency, so the winner is the one a reader would name.
    expect(answers[0].map((r) => r.label)).toEqual(["Sequoia"]);
  });

  test("topLinks=3 never drops a link that the previous identical call reported", async () => {
    const answers = await everyOrder("days=30&lite=1&byLink=1&topLinks=3");
    for (const rows of answers) expect(rows.map((r) => r.shareId)).toEqual(answers[0].map((r) => r.shareId));
    // And it is the right set: both views=2 links, plus the most recent of the views=1 links.
    expect(answers[0].map((r) => r.label)).toEqual(["Sequoia", "Probe expiring", "Index"]);
  });

  test("topLinks=5, the shape MetricsView asks for, names the same winner on every refresh", async () => {
    const answers = await everyOrder("days=30&lite=1&byLink=1&topLinks=5");
    for (const rows of answers) expect(rows.map((r) => r.label)).toEqual(answers[0].map((r) => r.label));
    expect(answers[0][0]?.label).toBe("Sequoia");
  });

  test("the unranked breakdown is ordered too — equal views no longer keep the aggregate's order", async () => {
    // No `topLinks`, so no `$facet`: here the only thing between an arbitrary row order and the
    // rendered table is the Node-side sort.
    const answers = await everyOrder("days=30&lite=1&byLink=1");
    for (const rows of answers) expect(rows.map((r) => r.shareId)).toEqual(answers[0].map((r) => r.shareId));
    expect(answers[0].map((r) => r.shareId)).toEqual([
      "pOu7rJLzNOxL",
      "WRdKDLq0IvNe",
      "WqSMXbt8zZTU",
      "E3FgZ594yOfl",
      "62OJLDR4NWIn",
    ]);
  });
});
