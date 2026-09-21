/**
 * Re-inviting someone must give them the role on the *invite*, not the role they used to hold.
 *
 * A revoke soft-deletes the membership (`isDeleted: true`) rather than removing the row, so the
 * obvious write here — one upsert on `{ orgId, userId }` with the role in `$setOnInsert` — matches
 * the revoked row, never runs the insert half, and leaves the old role in place. Invite a former
 * admin back as a viewer and they are an admin again: a permissions bug that looks like a no-op in
 * the diff, which is why it is pinned here (metis mt_k_-mEn9sDZ).
 *
 * The other half matters too: an existing member who clicks their invite link a second time — or
 * someone who forwards them an old one — must not have their role rewritten underneath them.
 *
 * All DB access is mocked, in the style of tests/lib/membershipRevocation.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  ORG_ID,
  USER_ID,
  MEMBERSHIP_ID,
  connectMongo,
  inviteFindOne,
  membershipFindOne,
  membershipExists,
  membershipUpdateOne,
  inviteUpdateOne,
  orgFindOne,
  resolveActor,
} = vi.hoisted(() => {
  const ORG_ID = "64b0c0ffee0000000000c001";
  const USER_ID = "64b0c0ffee0000000000c002";
  const MEMBERSHIP_ID = "64b0c0ffee0000000000c003";
  return {
    ORG_ID,
    USER_ID,
    MEMBERSHIP_ID,
    connectMongo: vi.fn(async () => undefined),
    inviteFindOne: vi.fn(),
    membershipFindOne: vi.fn(),
    membershipExists: vi.fn(async () => null as unknown),
    membershipUpdateOne: vi.fn(async () => ({ acknowledged: true })),
    inviteUpdateOne: vi.fn(async () => ({ acknowledged: true })),
    orgFindOne: vi.fn(),
    resolveActor: vi.fn(async () => ({ kind: "user" as const, userId: USER_ID, orgId: ORG_ID })),
  };
});

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/OrgInvite", () => ({ OrgInviteModel: { findOne: inviteFindOne, updateOne: inviteUpdateOne } }));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { findOne: membershipFindOne, exists: membershipExists, updateOne: membershipUpdateOne },
}));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findOne: orgFindOne } }));
vi.mock("@/lib/models/User", () => ({
  UserModel: { findById: () => ({ select: () => ({ lean: async () => ({ name: "Dana", email: "dana@example.com" }) }) }) },
}));
vi.mock("@/lib/billing/planLimits", () => ({
  checkLimit: vi.fn(async () => ({ ok: true })),
  planLimitResponse: vi.fn(),
}));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor, membershipChanged: vi.fn() }));
// Claiming an invite also takes the claimer out of the early-access queue; that write has its own
// tests (tests/lib/waitlist.test.ts) and would otherwise reach a model this file does not mock.
vi.mock("@/lib/waitlist/waitlist", () => ({ approveUser: vi.fn(async () => ({ ok: true, changed: false, email: null, name: null })) }));

import crypto from "node:crypto";

const TOKEN = "invite-token-under-test";

/** The invite as the route reads it: a live, unredeemed invite for `viewer`. */
function inviteRow(role: string) {
  return {
    _id: "64b0c0ffee0000000000c004",
    orgId: ORG_ID,
    role,
    expiresAt: new Date(Date.now() + 60_000),
    redeemedAt: null,
  };
}

/** The membership row the route reads before deciding how to write. */
function setMembership(row: { isDeleted?: boolean } | null) {
  membershipFindOne.mockReturnValue({
    select: () => ({ lean: async () => (row ? { _id: MEMBERSHIP_ID, ...row } : null) }),
  });
}

/** Every `$set` the route wrote to the membership collection, merged. */
function membershipSets(): Record<string, unknown> {
  return membershipUpdateOne.mock.calls.reduce((acc, call) => {
    const update = (call as unknown[])[1] as { $set?: Record<string, unknown> } | undefined;
    return { ...acc, ...(update?.$set ?? {}) };
  }, {} as Record<string, unknown>);
}

async function claim(): Promise<Response> {
  const { POST } = await import("@/app/api/org-invites/claim/route");
  return POST(
    new Request("http://localhost/api/org-invites/claim", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: TOKEN }),
    }),
  );
}

describe("invite claim: which role the member ends up with", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    inviteFindOne.mockReturnValue({ select: () => ({ lean: async () => inviteRow("viewer") }) });
    orgFindOne.mockReturnValue({ select: () => ({ lean: async () => ({ type: "team" }) }) });
    membershipExists.mockResolvedValue(null);
    membershipUpdateOne.mockResolvedValue({ acknowledged: true });
    // The token the route hashes has to match the invite it finds; the lookup is mocked, so any
    // hash does — this keeps the intent visible.
    expect(crypto.createHash("sha256").update(TOKEN).digest("hex")).toHaveLength(64);
  });

  test("a first join is inserted with the invite's role", async () => {
    setMembership(null);
    const res = await claim();
    expect(res.status).toBe(200);
    const [, update, options] = membershipUpdateOne.mock.calls[0] as unknown[];
    expect((options as { upsert?: boolean }).upsert).toBe(true);
    expect((update as { $setOnInsert?: { role?: string } }).$setOnInsert?.role).toBe("viewer");
  });

  test("a revoked admin re-invited as a viewer comes back a viewer", async () => {
    setMembership({ isDeleted: true });
    const res = await claim();
    expect(res.status).toBe(200);
    const sets = membershipSets();
    expect(sets.role).toBe("viewer");
    expect(sets.isDeleted).toBe(false);
  });

  test("an existing member re-clicking an invite keeps the role they have", async () => {
    setMembership({ isDeleted: false });
    membershipExists.mockResolvedValue({ _id: MEMBERSHIP_ID });
    const res = await claim();
    expect(res.status).toBe(200);
    const sets = membershipSets();
    expect(sets).not.toHaveProperty("role");
    expect(sets.isDeleted).toBe(false);
    // Nothing is written through the upsert path either, which would carry a role with it.
    for (const call of membershipUpdateOne.mock.calls) {
      expect((call as unknown[])[1]).not.toHaveProperty("$setOnInsert");
    }
  });
});
