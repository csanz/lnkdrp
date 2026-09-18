/**
 * The document-scope rule: **a read through a project link is the project's view, not the
 * document's** (docs/METRICS.md, `src/lib/analytics/docScope.ts`).
 *
 * This is pinned rather than left to review because it is a rule that has to hold on four surfaces
 * that share no code path — the live metrics route, the `metricsSnapshot` rollup behind the
 * dashboard card and QuickStats, and the two ingest counters — and it shipped once holding on only
 * the first. The visible symptom was not a crash: `Doc.metricsSnapshot.lastDaysViews` simply sat
 * above what `/doc/:id/metrics` reported for the same window, so QuickStats rendered the snapshot,
 * flashed the larger number and swapped to the smaller one when the route answered, while the
 * dashboard card — which never calls the route — stayed wrong forever.
 *
 * The models are mocked in the style of tests/lib/shareLinks.test.ts: the assertions are about the
 * filters the rollup *issues*, which is exactly where the rule lives.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const DOC_ID = new Types.ObjectId();
/** The document's own link, and a data room the document also sits in. */
const OWN_SLUG = "own-link-slug";
const PROJECT_SLUG = "data-room-slug";

const countDocuments = vi.fn(async (_filter: Record<string, any>) => 0);
const aggregate = vi.fn(async (_stages: Array<Record<string, any>>) => [] as unknown[]);
const shareViewDistinct = vi.fn(async () => [OWN_SLUG, PROJECT_SLUG]);
/** `ShareLinkModel.find({...}).distinct("shareId")` — which of those slugs are project links. */
const shareLinkDistinct = vi.fn(async () => [PROJECT_SLUG]);
const shareLinkFind = vi.fn(() => ({ distinct: shareLinkDistinct }));
const docUpdateOne = vi.fn(async () => ({ acknowledged: true }));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));

vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: {
    countDocuments: (filter: Record<string, any>) => countDocuments(filter),
    aggregate: (stages: Array<Record<string, any>>) => aggregate(stages),
    distinct: (...args: unknown[]) => shareViewDistinct(...(args as [])),
  },
}));

vi.mock("@/lib/models/ShareLink", () => ({
  PROJECT_LINK_FILTER: { kind: "project" },
  ShareLinkModel: { find: (...args: unknown[]) => shareLinkFind(...(args as [])) },
}));

vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    find: () => ({
      sort: () => ({
        select: () => ({
          limit: () => ({ lean: async () => [{ _id: DOC_ID }] }),
        }),
      }),
    }),
    updateOne: (...args: unknown[]) => docUpdateOne(...(args as [])),
  },
}));

const { rollupDocMetrics } = await import("@/lib/metrics/rollupDocMetrics");
const { projectLinkSlugsForDocs } = await import("@/lib/analytics/docScope");

beforeEach(() => {
  countDocuments.mockClear();
  aggregate.mockClear();
  shareViewDistinct.mockClear();
  shareLinkDistinct.mockClear();
  shareLinkFind.mockClear();
  docUpdateOne.mockClear();
});

describe("projectLinkSlugsForDocs", () => {
  test("returns the slugs the documents have traffic on that are project links", async () => {
    expect(await projectLinkSlugsForDocs([DOC_ID])).toEqual([PROJECT_SLUG]);
    // Derived from the rows, not from current project membership: a document removed from a
    // project keeps the rows it earned inside it and those stay excluded.
    expect(shareViewDistinct).toHaveBeenCalledWith("shareId", { docId: DOC_ID });
  });

  test("an id with no traffic costs one query, not two", async () => {
    shareViewDistinct.mockResolvedValueOnce([] as never);
    expect(await projectLinkSlugsForDocs([DOC_ID])).toEqual([]);
    expect(shareLinkFind).not.toHaveBeenCalled();
  });

  test("nothing to ask about asks nothing", async () => {
    expect(await projectLinkSlugsForDocs([])).toEqual([]);
    expect(shareViewDistinct).not.toHaveBeenCalled();
  });
});

describe("rollupDocMetrics", () => {
  test("the snapshot excludes project-link traffic, exactly as the metrics route does", async () => {
    await rollupDocMetrics({ docId: String(DOC_ID), days: 15 });

    const filter = countDocuments.mock.calls[0]![0];
    expect(String(filter.docId)).toBe(String(DOC_ID));
    // The bug: this key was absent, so `metricsSnapshot.lastDaysViews` counted the data room's
    // reading and exceeded what `/api/docs/:docId/shareviews` reports for the same window.
    expect(filter.shareId).toEqual({ $nin: [PROJECT_SLUG] });
    // `$nin`, never an `$in` of the document's own slugs: traffic whose link was hard-deleted has
    // no `ShareLink` row and still belongs to the document (`deletedLinkResidual`).
    expect(filter.shareId.$in).toBeUndefined();
    // The two rules the snapshot already had must survive beside the new one.
    expect(filter.isOwnerPreview).toEqual({ $ne: true });
    expect(filter.$or).toBeTruthy();
  });

  test("the download aggregates are bounded by the same rule as the views", async () => {
    await rollupDocMetrics({ docId: String(DOC_ID), days: 15 });
    // Both pipelines (windowed downloads, lifetime downloads) start with the same `$match`.
    for (const call of aggregate.mock.calls) {
      expect(call[0][0].$match.shareId).toEqual({ $nin: [PROJECT_SLUG] });
    }
    expect(aggregate.mock.calls.length).toBe(2);
  });

  test("a document with no project traffic is bounded by nothing at all", async () => {
    shareLinkDistinct.mockResolvedValueOnce([] as never);
    await rollupDocMetrics({ docId: String(DOC_ID), days: 15 });
    // An empty `$nin` would be a clause Mongo has to evaluate for every row, and `shareIdClause`
    // returns `{}` instead. The document's own figures are then plain `{ docId }` reads.
    expect(countDocuments.mock.calls[0]![0].shareId).toBeUndefined();
  });

  test("the exclusion is computed once for the batch, not once per document", async () => {
    await rollupDocMetrics({ days: 15 });
    expect(shareViewDistinct).toHaveBeenCalledTimes(1);
    expect(shareLinkDistinct).toHaveBeenCalledTimes(1);
  });
});
