/**
 * The Teams tab's invite filter tabs ("Not used (3)") used to be counted off whatever GET
 * /api/org-invites happened to return, and that was a hard page of 25 with no total and no way to
 * ask for more: a workspace past 25 invites was shown confident numbers that were wrong, and its
 * oldest still-claimable links appeared under no filter at all, not even "All". These tests pin the
 * two halves of the fix — counts computed over the whole workspace, and a page the caller can walk.
 *
 * The third test pins the index that listing depends on. Its partial filter used to say
 * `{ isRevoked: { $ne: true } }`, which MongoDB refuses in a partial filter, so the index had never
 * been created on any database and nobody noticed. A whitelist is the only way to catch that from a
 * unit test, since the rejection only happens inside the server.
 *
 * All DB access is mocked, in the style of tests/lib/inviteClaimRole.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const { ORG_ID, USER_ID, connectMongo, inviteFind, inviteCountDocuments, orgFindOne, membershipFindOne, tryResolveAuthUserId } =
  vi.hoisted(() => {
    const ORG_ID = "64b0c0ffee0000000000d001";
    const USER_ID = "64b0c0ffee0000000000d002";
    return {
      ORG_ID,
      USER_ID,
      connectMongo: vi.fn(async () => undefined),
      inviteFind: vi.fn(),
      // Declared with the filter parameter so `mockImplementation` and `mock.calls` are typed with
      // it: `vi.fn(async () => 0)` infers a zero-arg signature, and every filter assertion below
      // then fails to compile.
      inviteCountDocuments: vi.fn(async (_filter: Record<string, unknown>) => 0),
      orgFindOne: vi.fn(),
      membershipFindOne: vi.fn(),
      tryResolveAuthUserId: vi.fn(async () => ({ userId: USER_ID, activeOrgId: ORG_ID })),
    };
  });

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/db/mongoRequestLogger", () => ({
  withMongoRequestLogging: (_request: Request, fn: () => Promise<Response>) => fn(),
}));
vi.mock("@/lib/models/OrgInvite", () => ({
  OrgInviteModel: { find: inviteFind, countDocuments: inviteCountDocuments },
}));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { findOne: orgFindOne } }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { findOne: membershipFindOne } }));
vi.mock("@/lib/models/User", () => ({ UserModel: { find: vi.fn() } }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn(async () => undefined) }));
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit: vi.fn(async () => ({ ok: true })), planLimitResponse: vi.fn() }));

/** What the route asked Mongo for, recorded off the find() chain. */
let lastPage: { skip: number; limit: number } = { skip: -1, limit: -1 };

/** An invite row as the route reads it; only the fields the serializer touches are present. */
function inviteRow(n: number) {
  return {
    _id: `64b0c0ffee00000000000${String(100 + n)}`,
    role: "member",
    expiresAt: new Date(Date.now() + 60_000),
    redeemedAt: null,
    redeemedByUserId: null,
    createdDate: new Date(),
    recipientEmail: null,
    tokenEnc: null,
    tokenEncIv: null,
    tokenEncTag: null,
  };
}

/** Make find() return `count` rows and remember the skip/limit it was given. */
function setInvitePage(count: number) {
  const rows = Array.from({ length: count }, (_, i) => inviteRow(i));
  inviteFind.mockReturnValue({
    select: () => ({
      sort: () => ({
        skip: (skip: number) => ({
          limit: (limit: number) => {
            lastPage = { skip, limit };
            return { lean: async () => rows };
          },
        }),
      }),
    }),
  });
}

async function listInvites(query = ""): Promise<Response> {
  const { GET } = await import("@/app/api/org-invites/route");
  return GET(new Request(`http://localhost/api/org-invites?orgId=${ORG_ID}${query}`, { method: "GET" }));
}

describe("GET /api/org-invites", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    lastPage = { skip: -1, limit: -1 };
    orgFindOne.mockReturnValue({ select: () => ({ lean: async () => ({ type: "team" }) }) });
    membershipFindOne.mockReturnValue({ select: () => ({ lean: async () => ({ role: "owner" }) }) });
  });

  test("counts describe the whole workspace, not the page that was returned", async () => {
    // 40 live invites: 6 already used, 9 expired, 25 still claimable — but only a page of 25 rows.
    setInvitePage(25);
    inviteCountDocuments.mockImplementation(async (filter: Record<string, unknown>) => {
      if ("expiresAt" in filter) return 9;
      if ("redeemedAt" in filter) return 6;
      return 40;
    });

    const res = await listInvites();
    expect(res.status).toBe(200);
    const json = (await res.json()) as {
      invites: unknown[];
      counts: { all: number; used: number; expired: number; notUsed: number };
      page: { limit: number; offset: number; hasMore: boolean };
    };

    expect(json.invites).toHaveLength(25);
    // Counted off the returned array, these would have read 25 / 0 / 0 / 25.
    expect(json.counts).toEqual({ all: 40, used: 6, expired: 9, notUsed: 25 });
    expect(json.page).toEqual({ limit: 25, offset: 0, hasMore: true });
  });

  test("every count is scoped to the org and excludes revoked invites by equality", async () => {
    setInvitePage(1);
    inviteCountDocuments.mockResolvedValue(1);

    await listInvites();

    expect(inviteCountDocuments).toHaveBeenCalledTimes(3);
    for (const [filter] of inviteCountDocuments.mock.calls as Array<[Record<string, unknown>]>) {
      expect(String(filter.orgId)).toBe(ORG_ID);
      // Equality, not `{ $ne: true }`: only this form lets the planner use the partial index.
      expect(filter.isRevoked).toBe(false);
    }
    // ...and the listing itself, which is the query the index exists for.
    const [listFilter] = inviteFind.mock.calls[0] as [Record<string, unknown>];
    expect(String(listFilter.orgId)).toBe(ORG_ID);
    expect(listFilter.isRevoked).toBe(false);
  });

  test("the page can be walked, and hasMore closes on the last one", async () => {
    setInvitePage(15);
    inviteCountDocuments.mockImplementation(async (filter: Record<string, unknown>) =>
      "expiresAt" in filter || "redeemedAt" in filter ? 0 : 40,
    );

    const res = await listInvites("&limit=25&offset=25");
    const json = (await res.json()) as { page: { limit: number; offset: number; hasMore: boolean } };

    expect(lastPage).toEqual({ skip: 25, limit: 25 });
    expect(json.page).toEqual({ limit: 25, offset: 25, hasMore: false });
  });

  test("limit is clamped, so one request cannot ask us to decrypt every token in the workspace", async () => {
    setInvitePage(1);
    inviteCountDocuments.mockResolvedValue(1);

    await listInvites("&limit=100000");

    expect(lastPage.limit).toBe(100);
  });
});

describe("OrgInvite indexes", () => {
  test("partial filters use only operators MongoDB accepts", async () => {
    const { OrgInviteModel } = await vi.importActual<typeof import("@/lib/models/OrgInvite")>("@/lib/models/OrgInvite");

    // The operators MongoDB allows inside a partialFilterExpression. $ne is the one that bit us:
    // createIndex rejects it, so the index was never built and the comment above it described an
    // index that did not exist.
    const ALLOWED = new Set(["$eq", "$exists", "$gt", "$gte", "$lt", "$lte", "$type", "$and", "$or", "$in"]);
    const operatorsIn = (value: unknown, found: string[] = []): string[] => {
      if (Array.isArray(value)) for (const v of value) operatorsIn(v, found);
      else if (value && typeof value === "object") {
        for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
          if (k.startsWith("$")) found.push(k);
          operatorsIn(v, found);
        }
      }
      return found;
    };

    const partials = OrgInviteModel.schema
      .indexes()
      .map(([, options]) => (options as { partialFilterExpression?: unknown } | undefined)?.partialFilterExpression)
      .filter((f): f is Record<string, unknown> => Boolean(f));

    expect(partials.length).toBeGreaterThan(0);
    for (const filter of partials) {
      for (const op of operatorsIn(filter)) expect(ALLOWED.has(op)).toBe(true);
    }
  });
});
