/**
 * Two invites redeemed at the same moment must not seat two people into one collaborator seat
 * (code review 2026-09-23, M4).
 *
 * The pre-check counts before either write, so both pass it. The route now counts again after its
 * own membership write; this test plays the losing racer: the second count says the workspace is
 * one over, the membership is deleted, the invite is released and the caller gets the same 402 the
 * pre-check would have given. The normal path is pinned alongside so the re-count is not a refusal
 * in disguise.
 */
import { Types } from "mongoose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  connectMongo: vi.fn(async () => undefined),
  resolveActor: vi.fn(),
  membershipChanged: vi.fn(),
  forbidApiKey: vi.fn(() => null),
  checkLimit: vi.fn(),
  planLimitResponse: vi.fn(),
  recordActivity: vi.fn(async () => undefined),
  approveUser: vi.fn(async () => undefined),
  accessStatusChanged: vi.fn(),
  invite: { findOne: vi.fn(), updateOne: vi.fn() },
  membership: { exists: vi.fn(), findOne: vi.fn(), updateOne: vi.fn(), deleteOne: vi.fn() },
  org: { findOne: vi.fn() },
  user: { findById: vi.fn() },
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: mocks.connectMongo }));
vi.mock("@/lib/debug", () => ({ debugLog: () => undefined, debugError: () => undefined }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor: mocks.resolveActor, membershipChanged: mocks.membershipChanged }));
vi.mock("@/lib/gating/forbidApiKey", () => ({ forbidApiKey: mocks.forbidApiKey }));
vi.mock("@/lib/gating/waitlist", () => ({ accessStatusChanged: mocks.accessStatusChanged }));
vi.mock("@/lib/waitlist/waitlist", () => ({ approveUser: mocks.approveUser }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: mocks.recordActivity }));
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit: mocks.checkLimit, planLimitResponse: mocks.planLimitResponse }));
vi.mock("@/lib/models/OrgInvite", () => ({ OrgInviteModel: mocks.invite }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: mocks.membership }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: mocks.org }));
vi.mock("@/lib/models/User", () => ({ UserModel: mocks.user }));

import { NextResponse } from "next/server";

import { POST } from "@/app/api/org-invites/claim/route";

const ORG_ID = new Types.ObjectId("aaaaaaaaaaaaaaaaaaaaaaaa");
const USER_ID = "bbbbbbbbbbbbbbbbbbbbbbbb";
const INVITE_ID = new Types.ObjectId("cccccccccccccccccccccccc");

/** `Model.findOne(...).select(...).lean()` resolving to `value`. */
function chain<T>(value: T) {
  return { select: () => ({ lean: async () => value }) };
}

function request(): Request {
  return new Request("http://localhost/api/org-invites/claim", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token: "tok" }),
  });
}

const blocked = {
  ok: false as const,
  code: "plan_limit" as const,
  limit: "collaborators" as const,
  used: 4,
  requested: 0,
  max: 3,
  grace: null,
  upgradeUrl: "/pricing",
  message: "Pro includes 3 collaborators.",
};

describe("POST /api/org-invites/claim, seat race", () => {
  beforeEach(() => {
    for (const group of [mocks.invite, mocks.membership, mocks.org, mocks.user]) {
      for (const fn of Object.values(group)) (fn as ReturnType<typeof vi.fn>).mockReset();
    }
    mocks.checkLimit.mockReset();
    mocks.planLimitResponse.mockReset();
    mocks.approveUser.mockClear();
    mocks.membershipChanged.mockClear();

    mocks.resolveActor.mockResolvedValue({ kind: "user", userId: USER_ID, orgId: String(ORG_ID) });
    mocks.invite.findOne.mockReturnValue(
      chain({
        _id: INVITE_ID,
        orgId: ORG_ID,
        role: "member",
        expiresAt: new Date(Date.now() + 60_000),
        redeemedAt: null,
        recipientEmail: "",
      }),
    );
    mocks.org.findOne.mockReturnValue(chain({ type: "team" }));
    mocks.membership.exists.mockResolvedValue(null);
    mocks.membership.findOne.mockReturnValue(chain(null));
    mocks.membership.updateOne.mockResolvedValue({ acknowledged: true });
    mocks.membership.deleteOne.mockResolvedValue({ deletedCount: 1 });
    mocks.invite.updateOne.mockResolvedValue({ matchedCount: 1 });
    mocks.user.findById.mockReturnValue(chain({ name: "Dana", email: "dana@example.com" }));
    mocks.planLimitResponse.mockImplementation((check: Record<string, unknown>) =>
      NextResponse.json({ error: check.message, ...check }, { status: 402 }),
    );
  });

  afterEach(() => vi.restoreAllMocks());

  it("the losing racer is unseated, the invite released, and the answer is the pre-check's 402", async () => {
    // Pre-check sees a free seat; the re-count after the write sees the sibling too.
    mocks.checkLimit.mockResolvedValueOnce({ ok: true, warning: null }).mockResolvedValueOnce(blocked);

    const res = await POST(request());
    expect(res.status).toBe(402);

    // Counted twice: once before the write, once after, with `adding: 0`.
    expect(mocks.checkLimit).toHaveBeenCalledTimes(2);
    expect((mocks.checkLimit.mock.calls as unknown[][])[1]).toEqual([String(ORG_ID), "collaborators", { role: "member", adding: 0 }]);

    // The fresh membership row is gone.
    expect(mocks.membership.deleteOne).toHaveBeenCalledWith({ orgId: ORG_ID, userId: new Types.ObjectId(USER_ID) });
    // The token is claimable again, and only this request's claim could be released.
    const release = (mocks.invite.updateOne.mock.calls as unknown[][]).find(
      (c) => (c[1] as { $set?: { redeemedAt?: unknown } }).$set?.redeemedAt === null,
    );
    expect(release?.[0]).toEqual({ _id: INVITE_ID, redeemedByUserId: new Types.ObjectId(USER_ID) });
    // The cached membership answer is invalidated.
    expect(mocks.membershipChanged).toHaveBeenCalledWith({ orgId: String(ORG_ID), userId: USER_ID });
    // Nothing downstream of a successful join happened.
    expect(mocks.approveUser).not.toHaveBeenCalled();
    expect(mocks.recordActivity).not.toHaveBeenCalledWith(expect.objectContaining({ type: "member.joined" }));
    // Reported as the workspace stands after the rollback: this seat is no longer counted.
    const reported = (mocks.planLimitResponse.mock.calls as unknown[][])[0][0] as { used: number; max: number };
    expect(reported).toMatchObject({ used: 3, max: 3 });
  });

  it("a revived membership goes back to deleted with its old role", async () => {
    mocks.membership.findOne.mockReturnValue(chain({ _id: new Types.ObjectId(), isDeleted: true, role: "admin" }));
    mocks.checkLimit.mockResolvedValueOnce({ ok: true, warning: null }).mockResolvedValueOnce(blocked);

    const res = await POST(request());
    expect(res.status).toBe(402);
    expect(mocks.membership.deleteOne).not.toHaveBeenCalled();
    const rollback = (mocks.membership.updateOne.mock.calls as unknown[][]).at(-1)?.[1] as { $set: Record<string, unknown> };
    expect(rollback.$set).toMatchObject({ isDeleted: true, role: "admin" });
  });

  it("within the cap after the write, the join goes through", async () => {
    mocks.checkLimit.mockResolvedValue({ ok: true, warning: null });

    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(mocks.checkLimit).toHaveBeenCalledTimes(2);
    expect(mocks.membership.deleteOne).not.toHaveBeenCalled();
    expect(mocks.approveUser).toHaveBeenCalledWith({ userId: USER_ID });
    expect(mocks.planLimitResponse).not.toHaveBeenCalled();
  });

  it("a viewer takes no seat, so there is nothing to re-count", async () => {
    mocks.invite.findOne.mockReturnValue(
      chain({ _id: INVITE_ID, orgId: ORG_ID, role: "viewer", expiresAt: new Date(Date.now() + 60_000), redeemedAt: null }),
    );
    mocks.checkLimit.mockResolvedValue({ ok: true, warning: null });

    const res = await POST(request());
    expect(res.status).toBe(200);
    // Only the pre-check, which itself short-circuits on viewers.
    expect(mocks.checkLimit).toHaveBeenCalledTimes(1);
  });
});
