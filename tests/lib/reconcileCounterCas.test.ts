/**
 * The nightly counter reconcile writes with compare-and-set: the values it read are in the
 * update's filter, so a view that landed in between is not erased (code review 2026-09-23,
 * Admin / cron).
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  viewAggregate: vi.fn(async () => [] as unknown[]),
  linkFind: vi.fn(),
  linkUpdateOne: vi.fn(async () => ({ matchedCount: 1, modifiedCount: 1 })),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: async () => undefined }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { aggregate: mocks.viewAggregate, distinct: async () => [] } }));
vi.mock("@/lib/models/ShareLink", () => ({
  PROJECT_LINK_FILTER: { projectId: { $ne: null } },
  ShareLinkModel: {
    // `find(...).distinct("shareId")` for project slugs, `find(...).select(...).lean()` for the links.
    find: () => ({
      distinct: async () => [],
      select: () => ({ lean: () => mocks.linkFind() }),
    }),
    distinct: async () => [],
    updateOne: mocks.linkUpdateOne,
  },
}));
vi.mock("@/lib/share/projectLinks", () => ({ projectLinkStatsByShareId: async () => new Map() }));

import { reconcileShareLinkCounters } from "@/lib/analytics/reconcileLinkCounters";

const LINK = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const LAST = new Date("2026-09-24T10:00:00Z");

describe("reconcileShareLinkCounters", () => {
  beforeEach(() => {
    mocks.viewAggregate.mockReset().mockResolvedValue([{ _id: "slug1", viewCount: 6, downloadCount: 1, lastViewedAt: LAST }]);
    mocks.linkFind.mockReset().mockResolvedValue([{ _id: LINK, shareId: "slug1", viewCount: 5, downloadCount: 1, lastViewedAt: LAST }]);
    mocks.linkUpdateOne.mockReset().mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
  });

  it("puts the stored values in the filter so a concurrent increment is not overwritten", async () => {
    const res = await reconcileShareLinkCounters();
    expect(res.linksReconciled).toBe(1);
    const [filter, update] = (mocks.linkUpdateOne.mock.calls as unknown[][])[0] as [Record<string, unknown>, { $set: Record<string, unknown> }];
    expect(filter).toEqual({ _id: LINK, viewCount: 5, downloadCount: 1, lastViewedAt: LAST });
    expect(update.$set).toEqual({ viewCount: 6, downloadCount: 1, lastViewedAt: LAST });
  });

  it("does not count a link whose row moved since it was read", async () => {
    mocks.linkUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });
    const res = await reconcileShareLinkCounters();
    expect(res.linksReconciled).toBe(0);
    // The drift is still reported: it was real when read.
    expect(res.drift).toHaveLength(1);
  });

  it("writes nothing on a dry run", async () => {
    const res = await reconcileShareLinkCounters({ dryRun: true });
    expect(mocks.linkUpdateOne).not.toHaveBeenCalled();
    expect(res.linksReconciled).toBe(1);
  });
});
