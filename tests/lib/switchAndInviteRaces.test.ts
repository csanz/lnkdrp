/**
 * Two side effects that happened before anything had the right to ask for them.
 *
 * - `GET /org/switch` writes `metadata.activeOrgId` onto the user record and sets a year-long
 *   active-org cookie. It is a GET with no CSRF token, reached with a `SameSite=Lax` session
 *   cookie that rides along on top-level navigations, so a link sent in mail or chat flipped the
 *   victim's workspace under them — silently, because membership is genuinely valid, and durably,
 *   because the active org is persisted on the user record and follows them to their other
 *   devices. Pinned here as "the app's own navigations still switch; a link somebody sent does
 *   not", including the deliberate degrade for clients that send no Fetch Metadata at all.
 *
 * - `POST /api/org-invites/claim` read `redeemedAt` at the top and stamped it at the bottom, with
 *   the membership insert, the waitlist approval and the collaborator-cap check all sitting in the
 *   gap. Concurrent claims of one token therefore all passed the read and all seated a member.
 *   Pinned here as "the token is claimed before anything is granted with it, and a claim that
 *   loses grants nothing".
 *
 * All DB access is mocked, in the style of tests/lib/inviteClaimRole.test.ts and
 * tests/lib/crossTenantScoping.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG_ID = new Types.ObjectId().toString();
const OTHER_ORG_ID = new Types.ObjectId().toString();
const USER_ID = new Types.ObjectId().toString();
const INVITE_ID = new Types.ObjectId();
const MEMBERSHIP_ID = new Types.ObjectId();

// --- shared module mocks -----------------------------------------------------------------------

const {
  connectMongo,
  resolveActor,
  activeOrgChanged,
  membershipChanged,
  userUpdateOne,
  membershipExists,
  membershipFindOne,
  membershipUpdateOne,
  docExists,
  inviteFindOne,
  inviteUpdateOne,
  orgFindOne,
  approveUser,
  checkLimit,
} = vi.hoisted(() => ({
  connectMongo: vi.fn(async () => undefined),
  resolveActor: vi.fn(),
  activeOrgChanged: vi.fn(),
  membershipChanged: vi.fn(),
  userUpdateOne: vi.fn(async (..._a: unknown[]) => ({ acknowledged: true })),
  membershipExists: vi.fn(async (..._a: unknown[]) => null as unknown),
  membershipFindOne: vi.fn(),
  membershipUpdateOne: vi.fn(async (..._a: unknown[]) => ({ acknowledged: true })),
  docExists: vi.fn(async (..._a: unknown[]) => ({ _id: new Types.ObjectId() })),
  inviteFindOne: vi.fn(),
  inviteUpdateOne: vi.fn(async (..._a: unknown[]) => ({ matchedCount: 1, modifiedCount: 1 })),
  orgFindOne: vi.fn(),
  approveUser: vi.fn(async () => ({ ok: true, changed: false, email: null, name: null })),
  checkLimit: vi.fn(async () => ({ ok: true })),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor, activeOrgChanged, membershipChanged }));
vi.mock("@/lib/gating/waitlist", () => ({ accessStatusChanged: vi.fn() }));
vi.mock("@/lib/models/User", () => ({
  UserModel: {
    updateOne: userUpdateOne,
    findById: () => ({ select: () => ({ lean: async () => ({ name: "Dana", email: "dana@example.com" }) }) }),
  },
}));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { exists: membershipExists, findOne: membershipFindOne, updateOne: membershipUpdateOne },
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { exists: docExists } }));
vi.mock("@/lib/models/OrgInvite", () => ({ OrgInviteModel: { findOne: inviteFindOne, updateOne: inviteUpdateOne } }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findOne: orgFindOne } }));
vi.mock("@/lib/waitlist/waitlist", () => ({ approveUser }));
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit, planLimitResponse: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));

import { ACTIVE_ORG_COOKIE } from "@/lib/orgs/activeOrgCookie";

// --- /org/switch -------------------------------------------------------------------------------

/**
 * Calls the switch route the way a browser would, with whatever Fetch Metadata that browser stamps.
 *
 * `undefined` means "this client sends no `Sec-Fetch-Site` at all" — an older browser, or the
 * product's own server-side callers — which is the case the route deliberately still honours.
 */
async function switchTo(orgId: string, secFetchSite: string | undefined): Promise<Response> {
  const { GET } = await import("@/app/org/switch/route");
  const headers = new Headers();
  if (secFetchSite) headers.set("sec-fetch-site", secFetchSite);
  return GET(new Request(`http://localhost/org/switch?orgId=${orgId}&returnTo=%2Fdashboard`, { headers }));
}

/** The `metadata.activeOrgId` this request persisted, or null if it persisted nothing. */
function persistedActiveOrgId(): string | null {
  const call = userUpdateOne.mock.calls[0];
  if (!call) return null;
  const update = call[1] as { $set?: Record<string, unknown> } | undefined;
  const value = update?.$set?.["metadata.activeOrgId"];
  return typeof value === "string" ? value : null;
}

describe("/org/switch: a link somebody sent is not a workspace switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    resolveActor.mockResolvedValue({ kind: "user", userId: USER_ID, orgId: ORG_ID });
    membershipExists.mockResolvedValue({ _id: MEMBERSHIP_ID });
  });

  test("the app's own navigation still switches, cookie and all", async () => {
    const res = await switchTo(OTHER_ORG_ID, "same-origin");
    expect(res.status).toBe(200);
    expect(persistedActiveOrgId()).toBe(OTHER_ORG_ID);
    // NextResponse exposes the cookie it is about to set; this is the year-long one.
    const cookie = (res as unknown as { cookies: { get(n: string): { value: string } | undefined } }).cookies.get(
      ACTIVE_ORG_COOKIE,
    );
    expect(cookie?.value).toBe(OTHER_ORG_ID);
    expect(activeOrgChanged).toHaveBeenCalledWith(USER_ID);
  });

  test("a cross-site navigation writes nothing and sets no cookie", async () => {
    const res = await switchTo(OTHER_ORG_ID, "cross-site");
    expect(userUpdateOne).not.toHaveBeenCalled();
    expect(persistedActiveOrgId()).toBeNull();
    expect(activeOrgChanged).not.toHaveBeenCalled();
    const cookie = (res as unknown as { cookies: { get(n: string): { value: string } | undefined } }).cookies.get(
      ACTIVE_ORG_COOKIE,
    );
    expect(cookie).toBeUndefined();
    // It degrades rather than refuses: the person lands in the app, in the workspace they were in.
    expect(res.status).toBe(307);
    expect(new URL(res.headers.get("location") ?? "", "http://localhost").pathname).toBe("/");
  });

  test("a link opened out of a mail or chat client (`none`) writes nothing", async () => {
    await switchTo(OTHER_ORG_ID, "none");
    expect(userUpdateOne).not.toHaveBeenCalled();
    expect(persistedActiveOrgId()).toBeNull();
  });

  test("a client that sends no Fetch Metadata at all is still allowed to switch", async () => {
    const res = await switchTo(OTHER_ORG_ID, undefined);
    expect(res.status).toBe(200);
    expect(persistedActiveOrgId()).toBe(OTHER_ORG_ID);
  });
});

// --- /api/org-invites/claim --------------------------------------------------------------------

const TOKEN = "invite-token-under-test";

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

/** The invite `updateOne` call that claims the token (the one filtered on `redeemedAt: null`). */
function claimCall(): [Record<string, unknown>, Record<string, unknown>] | null {
  const call = inviteUpdateOne.mock.calls.find((c) => {
    const filter = (c as unknown[])[0] as Record<string, unknown>;
    return filter && "redeemedAt" in filter && filter.redeemedAt === null;
  });
  return call ? ([call[0], call[1]] as [Record<string, unknown>, Record<string, unknown>]) : null;
}

describe("/api/org-invites/claim: one token seats one account", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    resolveActor.mockResolvedValue({ kind: "user", userId: USER_ID, orgId: ORG_ID });
    inviteFindOne.mockReturnValue({
      select: () => ({
        lean: async () => ({
          _id: INVITE_ID,
          orgId: ORG_ID,
          role: "member",
          expiresAt: new Date(Date.now() + 60_000),
          redeemedAt: null,
        }),
      }),
    });
    orgFindOne.mockReturnValue({ select: () => ({ lean: async () => ({ type: "team" }) }) });
    membershipFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    membershipExists.mockResolvedValue(null);
    membershipUpdateOne.mockResolvedValue({ acknowledged: true });
    inviteUpdateOne.mockResolvedValue({ matchedCount: 1, modifiedCount: 1 });
    checkLimit.mockResolvedValue({ ok: true });
  });

  test("the token is claimed before the membership is written", async () => {
    const order: string[] = [];
    inviteUpdateOne.mockImplementation(async () => {
      order.push("invite");
      return { matchedCount: 1, modifiedCount: 1 };
    });
    membershipUpdateOne.mockImplementation(async () => {
      order.push("membership");
      return { acknowledged: true };
    });

    const res = await claim();
    expect(res.status).toBe(200);
    // The whole defect was this ordering: the stamp used to come last.
    expect(order).toEqual(["invite", "membership"]);

    const call = claimCall();
    expect(call).not.toBeNull();
    const [filter, update] = call!;
    // The conditional filter is what makes it a lock rather than an announcement.
    expect(filter._id).toBe(INVITE_ID);
    expect(filter.redeemedAt).toBeNull();
    expect((update.$set as Record<string, unknown>).redeemedAt).toBeInstanceOf(Date);
  });

  test("the racer that loses the claim seats nobody", async () => {
    // What a sibling request sees once the winner has stamped the token: the conditional update
    // matches no document.
    inviteUpdateOne.mockResolvedValue({ matchedCount: 0, modifiedCount: 0 });

    const res = await claim();
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: "Invalid or expired invite" });
    expect(membershipUpdateOne).not.toHaveBeenCalled();
    // ...and is not quietly lifted off the early-access queue on the way out.
    expect(approveUser).not.toHaveBeenCalled();
    expect(membershipChanged).not.toHaveBeenCalled();
  });

  test("a result with no matchedCount is treated as a win, not a refusal", async () => {
    // Deliberate degrade: an unreadable driver reply must not start rejecting valid invites.
    inviteUpdateOne.mockResolvedValue({ acknowledged: true } as never);
    const res = await claim();
    expect(res.status).toBe(200);
    expect(membershipUpdateOne).toHaveBeenCalled();
  });

  test("a failed membership write puts the claim back", async () => {
    membershipUpdateOne.mockRejectedValue(new Error("write concern failed"));

    const res = await claim();
    expect(res.status).toBe(500);
    const release = inviteUpdateOne.mock.calls.find((c) => {
      const update = (c as unknown[])[1] as { $set?: Record<string, unknown> };
      return update?.$set?.redeemedAt === null;
    });
    expect(release).toBeDefined();
    // Scoped so it can only release this request's own claim, never a sibling's.
    expect((release![0] as Record<string, unknown>).redeemedByUserId).toBeDefined();
  });
});
