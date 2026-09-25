/**
 * Deletion planning helpers (code review 2026-09-23, Billing / identity and Admin / cron):
 * `findAccountsDueForPurge` asks for one account directly when given its id, and
 * `countOtherMembersByOrg` is one aggregate for every workspace at once.
 */
import { Types } from "mongoose";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  userFind: vi.fn(),
  membershipAggregate: vi.fn(async (): Promise<Array<{ _id: unknown; others: number; admins: number }>> => []),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: async () => undefined }));
vi.mock("@/lib/models/User", () => ({
  UserModel: {
    find: (filter: unknown) => ({
      select: () => ({ limit: (n: number) => ({ lean: () => mocks.userFind(filter, n) }) }),
    }),
  },
}));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { aggregate: mocks.membershipAggregate } }));

import { countOtherMembersByOrg, findAccountsDueForPurge } from "@/lib/accounts/purge";

const USER = "cccccccccccccccccccccccc";
const ME = new Types.ObjectId("dddddddddddddddddddddddd");
const ORG_A = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const ORG_B = new Types.ObjectId("bbbbbbbbbbbbbbbbbbbbbbbb");

describe("findAccountsDueForPurge", () => {
  beforeEach(() => mocks.userFind.mockReset().mockResolvedValue([{ _id: new Types.ObjectId(USER) }]));

  it("queries the one account directly when an id is given", async () => {
    const now = new Date("2026-09-25T00:00:00Z");
    const due = await findAccountsDueForPurge(now, 25, USER);
    expect(due).toEqual([USER]);
    const [filter, limit] = (mocks.userFind.mock.calls as unknown[][])[0] as [Record<string, unknown>, number];
    expect(filter._id).toEqual(new Types.ObjectId(USER));
    expect(filter).toMatchObject({ deletionPurgedAt: null, deletionPurgeAfter: { $lte: now } });
    expect(limit).toBe(1);
  });

  it("scans by due date, bounded by the limit, when no id is given", async () => {
    await findAccountsDueForPurge(new Date(), 40);
    const [filter, limit] = (mocks.userFind.mock.calls as unknown[][])[0] as [Record<string, unknown>, number];
    expect(filter).not.toHaveProperty("_id");
    expect(limit).toBe(40);
  });
});

describe("countOtherMembersByOrg", () => {
  beforeEach(() => mocks.membershipAggregate.mockReset().mockResolvedValue([]));

  it("is one aggregate over every workspace, excluding the person", async () => {
    mocks.membershipAggregate.mockResolvedValue([{ _id: ORG_A, others: 3, admins: 1 }]);
    const out = await countOtherMembersByOrg(ME, [ORG_A, ORG_B]);
    expect(mocks.membershipAggregate).toHaveBeenCalledTimes(1);
    const [pipeline] = (mocks.membershipAggregate.mock.calls as unknown[][])[0] as [Array<Record<string, unknown>>];
    expect(pipeline[0].$match).toEqual({ orgId: { $in: [ORG_A, ORG_B] }, userId: { $ne: ME }, isDeleted: { $ne: true } });
    expect(out.get(String(ORG_A))).toEqual({ others: 3, admins: 1 });
    // A workspace with nobody else is simply absent.
    expect(out.get(String(ORG_B))).toBeUndefined();
  });

  it("asks nothing for no workspaces", async () => {
    const out = await countOtherMembersByOrg(ME, []);
    expect(out.size).toBe(0);
    expect(mocks.membershipAggregate).not.toHaveBeenCalled();
  });
});
