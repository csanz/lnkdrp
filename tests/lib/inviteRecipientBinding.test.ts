/**
 * An emailed invite is addressed to someone, and `POST /api/org-invites/claim` must hold it to
 * that address.
 *
 * `recipientEmail` was written when the invite was sent and listed back in the Teams tab, but the
 * claim handler never compared it to anything: it selected `_id, orgId, role, expiresAt,
 * redeemedAt`, took the role verbatim and seated whoever was signed in. An `admin` invite that was
 * forwarded, quoted in a reply-all, or found in a shared inbox therefore made the *finder* an
 * admin. The same handler had no `forbidApiKey`, so an `lnk_` key could redeem on its owner's
 * behalf — the half of the key-escalation fix that was left open when minting was closed.
 *
 * What is pinned here:
 * - a mismatched account is refused, and the invite is **not** spent by the refusal;
 * - `+tag` and dotted-Gmail spellings of the invited mailbox still join, so the check does not
 *   lock out the people it is supposed to let in;
 * - a link invite (no recipient) still works — those are bearer by design;
 * - a key-derived actor is refused before any lookup happens.
 *
 * All DB access is mocked, in the style of tests/lib/inviteClaimRole.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  ORG_ID,
  USER_ID,
  INVITE_ID,
  connectMongo,
  inviteFindOne,
  membershipFindOne,
  membershipExists,
  membershipUpdateOne,
  inviteUpdateOne,
  orgFindOne,
  resolveActor,
  userFindById,
} = vi.hoisted(() => {
  const ORG_ID = "64b0c0ffee0000000000d001";
  const USER_ID = "64b0c0ffee0000000000d002";
  const INVITE_ID = "64b0c0ffee0000000000d004";
  return {
    ORG_ID,
    USER_ID,
    INVITE_ID,
    connectMongo: vi.fn(async () => undefined),
    inviteFindOne: vi.fn(),
    membershipFindOne: vi.fn(),
    membershipExists: vi.fn(async () => null as unknown),
    membershipUpdateOne: vi.fn(async () => ({ acknowledged: true })),
    inviteUpdateOne: vi.fn(async () => ({ acknowledged: true, matchedCount: 1 })),
    orgFindOne: vi.fn(),
    resolveActor: vi.fn(),
    userFindById: vi.fn(),
  };
});

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/OrgInvite", () => ({ OrgInviteModel: { findOne: inviteFindOne, updateOne: inviteUpdateOne } }));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { findOne: membershipFindOne, exists: membershipExists, updateOne: membershipUpdateOne },
}));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findOne: orgFindOne } }));
vi.mock("@/lib/models/User", () => ({ UserModel: { findById: userFindById } }));
vi.mock("@/lib/billing/planLimits", () => ({
  checkLimit: vi.fn(async () => ({ ok: true })),
  planLimitResponse: vi.fn(),
}));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/gating/actor", () => ({ resolveActor, membershipChanged: vi.fn() }));
vi.mock("@/lib/waitlist/waitlist", () => ({
  approveUser: vi.fn(async () => ({ ok: true, changed: false, email: null, name: null })),
}));
vi.mock("@/lib/gating/waitlist", () => ({ accessStatusChanged: vi.fn() }));

const TOKEN = "invite-token-under-test";

/** The signed-in human the route resolves, optionally one whose session came from an `lnk_` key. */
function signedIn(opts?: { viaApiKey?: boolean }) {
  resolveActor.mockResolvedValue({
    kind: "user" as const,
    userId: USER_ID,
    orgId: ORG_ID,
    ...(opts?.viaApiKey ? { viaApiKey: { keyId: "key_1", scopes: ["*"] } } : {}),
  });
}

/** A live, unredeemed `admin` invite — with or without an address on the envelope. */
function setInvite(recipientEmail: string | null) {
  inviteFindOne.mockReturnValue({
    select: () => ({
      lean: async () => ({
        _id: INVITE_ID,
        orgId: ORG_ID,
        role: "admin",
        expiresAt: new Date(Date.now() + 60_000),
        redeemedAt: null,
        recipientEmail,
      }),
    }),
  });
}

/** The account doing the claiming, as the route reads it back from `UserModel`. */
function setClaimerEmail(email: string | null) {
  userFindById.mockReturnValue({ select: () => ({ lean: async () => ({ name: "Dana", email }) }) });
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

describe("invite claim: the address on the envelope", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    signedIn();
    setInvite("dana@corp.com");
    setClaimerEmail("dana@corp.com");
    orgFindOne.mockReturnValue({ select: () => ({ lean: async () => ({ type: "team" }) }) });
    membershipFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
    membershipExists.mockResolvedValue(null);
    membershipUpdateOne.mockResolvedValue({ acknowledged: true });
    inviteUpdateOne.mockResolvedValue({ acknowledged: true, matchedCount: 1 });
  });

  test("the invited person joins", async () => {
    const res = await claim();
    expect(res.status).toBe(200);
    const [, update, options] = membershipUpdateOne.mock.calls[0] as unknown[];
    expect((options as { upsert?: boolean }).upsert).toBe(true);
    expect((update as { $setOnInsert?: { role?: string } }).$setOnInsert?.role).toBe("admin");
  });

  test("a forwarded admin invite does not seat the finder", async () => {
    setClaimerEmail("stranger@elsewhere.com");
    const res = await claim();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe("INVITE_EMAIL_MISMATCH");
    // Nobody was seated, and — just as important — the token was not burned by the attempt, so
    // the person it was actually sent to can still use it.
    expect(membershipUpdateOne).not.toHaveBeenCalled();
    expect(inviteUpdateOne).not.toHaveBeenCalled();
  });

  test("an account with no email address is a mismatch, not a pass", async () => {
    setClaimerEmail(null);
    const res = await claim();
    expect(res.status).toBe(403);
    expect(membershipUpdateOne).not.toHaveBeenCalled();
  });

  test("a +tag alias of the invited mailbox still joins", async () => {
    setInvite("dana+lnkdrp@corp.com");
    setClaimerEmail("Dana@corp.com");
    const res = await claim();
    expect(res.status).toBe(200);
  });

  test("a dotted Gmail spelling still joins", async () => {
    setInvite("d.ana@gmail.com");
    setClaimerEmail("dana@gmail.com");
    const res = await claim();
    expect(res.status).toBe(200);
  });

  test("dots are not stripped outside Gmail — two different mailboxes stay different", async () => {
    setInvite("d.ana@corp.com");
    setClaimerEmail("dana@corp.com");
    const res = await claim();
    expect(res.status).toBe(403);
  });

  test("a link invite with no recipient is still bearer, by design", async () => {
    setInvite(null);
    setClaimerEmail("anyone@elsewhere.com");
    const res = await claim();
    expect(res.status).toBe(200);
  });

  test("an API key cannot redeem an invite, even the right one", async () => {
    signedIn({ viaApiKey: true });
    const res = await claim();
    expect(res.status).toBe(403);
    const body = (await res.json()) as { error?: string };
    expect(body.error).toBe("api_key_forbidden");
    // Refused before the token is even looked up.
    expect(inviteFindOne).not.toHaveBeenCalled();
    expect(membershipUpdateOne).not.toHaveBeenCalled();
  });
});
