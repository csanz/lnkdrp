/**
 * A data-room reader is named on every surface or on none: `projectLinkTraffic.viewerRows` of
 * `GET /api/docs/:docId/shareviews` has to know the name the reader typed on the landing page.
 *
 * That introduction is stored on the arrival row (`ProjectLinkView`, keyed by the bare device
 * digest) and, when the browser replays the profile it saved, on the `ShareView` rows too. The
 * section was built from a `ShareView` aggregate alone (`$first: "$viewerName"`), so a reader whose
 * client never replays the profile — no localStorage, a non-browser reader — came back with
 * `viewerName: null` here while the activity feed, the Slack message, the visit brief and the
 * project's own reader rows all named them (docs/prds/lnkdrp-project-links.md,
 * `src/lib/share/readerIdentity.ts`). "Anonymous" beside a feed row naming the same person in the
 * same minute reads as the feature being broken.
 *
 * Two rules are pinned, because they pull in opposite directions:
 * 1. the arrival row fills what the aggregate could not learn, in **one** query for the whole page;
 * 2. it is still behind the deep analytics tier and `?viewers=1` — filling a gap must never widen
 *    who sees a name.
 *
 * No database: the models are mocked in the style of tests/lib/topLinksRankingStability.test.ts and
 * tests/lib/slackMessages.test.ts, so the assertions are about the rows the route builds and the
 * filter it issues, which is where both rules live.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

/**
 * Everything the `vi.mock` factories reach for. They run while the route module is imported, i.e.
 * before any `const` in this file has been initialised.
 */
const fx = vi.hoisted(() => {
  const DOC_ID = "6ab20688d7e47b3f56a11aa7";
  const ORG_ID = "6ab20688d7e47b3f56a11bb8";
  const USER_ID = "6ab20688d7e47b3f56a11cc9";
  const PROJECT_ID = "6ab694307102af9d9d25d6a6";
  /** The data room's slug: one link, every document in the room behind it. */
  const PROJECT_SLUG = "p1DataRoom01";

  /** Device digests: sha256 hex, so 64 characters, the width `splitProjectViewerKey` relies on. */
  const ELENA = "e".repeat(64);
  const DANA = "d".repeat(64);
  const NOBODY = "b".repeat(64);
  /** A project-link row keys the viewer *and* the document: `<digest>.<docId>`. */
  const key = (digest: string) => `${digest}.${DOC_ID}`;

  type Group = {
    _id: { shareId: string; viewer: string };
    views: number;
    lastSeen: Date;
    timeSpentMs: number;
    pagesSeen: number[][];
    viewerUserId: null;
    viewerName: string | null;
    viewerEmail: string | null;
    viewerEmailSnapshot: string | null;
  };

  const group = (digest: string, name: string | null, email: string | null): Group => ({
    _id: { shareId: PROJECT_SLUG, viewer: key(digest) },
    views: 1,
    lastSeen: new Date(Date.UTC(2026, 8, 24, 9, 0, 0)),
    timeSpentMs: 60_000,
    pagesSeen: [[1, 2]],
    viewerUserId: null,
    viewerName: name,
    viewerEmail: email,
    viewerEmailSnapshot: null,
  });

  /**
   * The three cases, as the aggregate hands them over:
   * - Elena read without ever telling the document rows who she is (the defect);
   * - Dana's browser replayed her profile, so her rows already carry it;
   * - the third reader never introduced themselves anywhere.
   */
  const GROUPS: Group[] = [
    group(ELENA, null, null),
    group(DANA, "Dana Reyes", "dana@sequoia.example"),
    group(NOBODY, null, null),
  ];

  /** Arrival rows: Elena introduced herself on the landing page, and so, differently, did Dana. */
  const ARRIVALS = [
    {
      shareId: PROJECT_SLUG,
      botIdHash: ELENA,
      viewerUserId: null,
      viewerName: "Elena Ruiz",
      viewerEmail: null,
      viewerEmailSnapshot: "Elena@A16Z.example",
      lastViewedAt: new Date(Date.UTC(2026, 8, 24, 8, 0, 0)),
    },
    {
      shareId: PROJECT_SLUG,
      botIdHash: DANA,
      viewerUserId: null,
      viewerName: "Stale Arrival Name",
      viewerEmail: null,
      viewerEmailSnapshot: "stale@sequoia.example",
      lastViewedAt: new Date(Date.UTC(2026, 8, 24, 7, 0, 0)),
    },
  ];

  const state = { tier: "deep" as "deep" | "basic", arrivalFilters: [] as Array<Record<string, any>> };

  /** The project-traffic `$group`, recognised by the one accumulator only it has. */
  const isProjectTrafficPipeline = (stages: Array<Record<string, any>>) =>
    stages.some((s) => s?.$group?.pagesSeen?.$addToSet === "$pagesSeen");

  async function aggregate(stages: Array<Record<string, any>>) {
    if (!isProjectTrafficPipeline(stages)) return [];
    // The projection is the plan gate's first half: on Basic, and without `?viewers=1`, the
    // pipeline never asks for a name, so the mock must not hand one back either.
    const asks = Boolean(stages.find((s) => s?.$group)?.$group?.viewerName);
    return GROUPS.map(({ viewerName, viewerEmail, viewerEmailSnapshot, ...rest }) =>
      asks ? { ...rest, viewerName, viewerEmail, viewerEmailSnapshot } : rest,
    );
  }

  return { DOC_ID, ORG_ID, USER_ID, PROJECT_ID, PROJECT_SLUG, ELENA, DANA, NOBODY, GROUPS, ARRIVALS, state, aggregate };
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
  analyticsTierForPlan: () => fx.state.tier,
  clampAnalyticsDays: (_plan: unknown, days: number) => days,
  getWorkspacePlan: async () => (fx.state.tier === "deep" ? "pro" : "free"),
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
        lean: async () => [{ shareId: fx.PROJECT_SLUG, label: "Investors", projectId: fx.PROJECT_ID }],
      }),
      distinct: async () => [fx.PROJECT_SLUG],
    }),
    findOne: () => ({ lean: async () => null, select: () => ({ lean: async () => null }) }),
    exists: async () => null,
    countDocuments: async () => 1,
  },
}));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: { find: () => ({ select: () => ({ lean: async () => [{ _id: fx.PROJECT_ID, name: "Acme Deal Room" }] }) }) },
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { find: () => ({ select: () => ({ lean: async () => [] }) }) } }));
/** Every arrival read the route makes, with the filter it was given, so "one query" is assertable. */
vi.mock("@/lib/models/ProjectLinkView", () => ({
  ProjectLinkViewModel: {
    find: (filter: Record<string, any>) => {
      fx.state.arrivalFilters.push(filter);
      return { select: () => ({ sort: () => ({ limit: () => ({ lean: async () => fx.ARRIVALS }) }) }) };
    },
  },
}));
/** The whole document's traffic came through the data room's link, and none of its own. */
vi.mock("@/lib/analytics/docScope", () => ({
  docOnlyShareIdMatch: async () => ({ foreignShareIds: [fx.PROJECT_SLUG], match: {} }),
}));
vi.mock("@/lib/share/links", () => ({ toShareLinkDTO: (l: unknown) => l }));
vi.mock("@/lib/analytics/workspace/shape", () => ({ projectLinkMetricsHref: () => null }));
/**
 * The real `splitProjectViewerKey` — the rule under test keys arrival rows by the digest at the head
 * of `<digest>.<docId>`, so stubbing the split away would test nothing. Taken from the module that
 * defines it and has no imports, which keeps mongoose models out of this file.
 */
vi.mock("@/lib/share/projectPublic", async () => {
  const real = await import("@/lib/analytics/project/viewerKey");
  return { splitProjectViewerKey: real.splitProjectViewerKey, viewerKeyMatchClause: (k: string) => [{ botIdHash: k }] };
});

import { GET } from "@/app/api/docs/[docId]/shareviews/route";

type ViewerRow = {
  viewerKey: string | null;
  viewerHref: string | null;
  views: number;
  viewerName?: string | null;
  viewerEmail?: string | null;
};

async function viewerRows(query: string): Promise<ViewerRow[]> {
  const res = (await GET(new Request(`https://lnkdrp.test/api/docs/${fx.DOC_ID}/shareviews?${query}`), {
    params: Promise.resolve({ docId: fx.DOC_ID }),
  })) as Response;
  const body = (await res.json()) as {
    error?: string;
    analyticsTier?: string;
    projectLinkTraffic?: { viewerRows?: ViewerRow[] } | null;
  };
  expect(body.error).toBeUndefined();
  // The section is built inside its own `.catch(() => null)`, so a missing mock would otherwise
  // read as "this document has no project traffic" and every assertion below would vacuously pass.
  expect(body.projectLinkTraffic?.viewerRows).toBeDefined();
  return body.projectLinkTraffic?.viewerRows ?? [];
}

const rowFor = (rows: ViewerRow[], digest: string) => rows.find((r) => r.viewerKey === `a_${digest}`);

beforeEach(() => {
  fx.state.tier = "deep";
  fx.state.arrivalFilters = [];
});

describe("projectLinkTraffic.viewerRows names the reader the landing page knows", () => {
  test("a name that exists only on the arrival row reaches the row", async () => {
    const rows = await viewerRows("days=30&viewers=1");
    const elena = rowFor(rows, fx.ELENA);
    expect(elena?.viewerName).toBe("Elena Ruiz");
    // Stored as typed, reported lowercased, exactly as `pickReaderIdentity` does it everywhere else.
    expect(elena?.viewerEmail).toBe("elena@a16z.example");
    // The figures are still the aggregate's, and the reader is still addressed by the key this
    // aggregate grouped them under: filling a name must not rekey the row.
    expect(elena?.views).toBe(1);
    expect(elena?.viewerKey).toBe(`a_${fx.ELENA}`);
  });

  test("the row's own identity wins over the arrival row", async () => {
    // Dana's browser replayed the profile on every stats post, so her `ShareView` rows carry the
    // name she is using now. An older landing-page introduction must not overwrite it.
    const dana = rowFor(await viewerRows("days=30&viewers=1"), fx.DANA);
    expect(dana?.viewerName).toBe("Dana Reyes");
    expect(dana?.viewerEmail).toBe("dana@sequoia.example");
  });

  test("a reader who introduced themselves nowhere stays anonymous", async () => {
    const nobody = rowFor(await viewerRows("days=30&viewers=1"), fx.NOBODY);
    expect(nobody?.viewerName).toBeNull();
    expect(nobody?.viewerEmail).toBeNull();
  });

  test("one query for the whole page, not one per reader", async () => {
    const rows = await viewerRows("days=30&viewers=1");
    expect(rows).toHaveLength(3);
    expect(fx.state.arrivalFilters).toHaveLength(1);
    const filter = fx.state.arrivalFilters[0];
    expect(filter.shareId).toEqual({ $in: [fx.PROJECT_SLUG] });
    const digests = (filter.$or as Array<Record<string, any>>).flatMap((c) => c.botIdHash?.$in ?? []);
    // The two readers the aggregate could not name, by the bare digest the arrival row is keyed on
    // — never the `<digest>.<docId>` composite, which matches no arrival row at all.
    expect(new Set(digests)).toEqual(new Set([fx.ELENA, fx.NOBODY]));
    // Dana is not asked about: her rows already carry a name and an email.
    expect(digests).not.toContain(fx.DANA);
  });
});

describe("the plan gate still decides who sees a name", () => {
  test("Basic gets the counts and no identity, and no arrival row is read", async () => {
    fx.state.tier = "basic";
    const rows = await viewerRows("days=30&viewers=1");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row).not.toHaveProperty("viewerName");
      expect(row).not.toHaveProperty("viewerEmail");
    }
    expect(fx.state.arrivalFilters).toEqual([]);
  });

  test("deep without ?viewers=1 is the same: the rows are traffic, not people", async () => {
    const rows = await viewerRows("days=30");
    expect(rows).toHaveLength(3);
    for (const row of rows) expect(row).not.toHaveProperty("viewerName");
    expect(fx.state.arrivalFilters).toEqual([]);
  });
});

describe("pickReaderIdentity, the pure half the route reuses", () => {
  test("it fills only what the row is missing, from the newest view that knows it", async () => {
    const { pickReaderIdentity } = await import("@/lib/share/readerIdentity");
    const arrival = { viewerName: "Elena Ruiz", viewerEmailSnapshot: "Elena@A16Z.example", lastViewedAt: new Date(1) };
    expect(pickReaderIdentity({ viewerName: null, viewerEmail: null }, [arrival])).toEqual({
      viewerName: "Elena Ruiz",
      viewerEmail: "elena@a16z.example",
    });
    // An empty string is not a name: the aggregate's `$first` can return one, and the row must
    // still be filled.
    expect(pickReaderIdentity({ viewerName: "  ", viewerEmail: "" }, [arrival]).viewerName).toBe("Elena Ruiz");
    expect(pickReaderIdentity({ viewerName: "Dana Reyes", viewerEmail: "dana@sequoia.example" }, [arrival])).toEqual({});
    expect(pickReaderIdentity({ viewerName: null, viewerEmail: null }, [])).toEqual({});
  });
});
