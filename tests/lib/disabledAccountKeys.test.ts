/**
 * Disabling an account has to take the API keys with it.
 *
 * `DELETE /api/admin/data/users/:userId` — the staff "disable this account" button — used to be a
 * single `UserModel.updateOne({_id}, {$set:{isActive:false}})`. That is enough for the browser:
 * every signed-in request runs `isAccountDisabled` in the actor gate, so the session dies on the
 * next click. It is not enough for an agent. `verifyBearerToken` asks two questions about an `lnk_`
 * key — is it revoked, and is its owner still a member of the key's workspace — and neither one
 * changes when an account is disabled: disabling does not touch `ApiKey.revokedAt` and it does not
 * touch membership rows. So every key that person had ever minted kept full read/write, on every
 * workspace they belonged to, indefinitely, because nothing expires a key. Staff shutting down a
 * compromised account were closing the front door and leaving the automation running.
 *
 * Self-service deletion never had this hole — it revokes the keys itself
 * (`src/app/api/account/delete/route.ts`) — so the fix is to make the staff path do the same thing,
 * rather than to add a third question to the hot path: `revokedAt` is read from the database on
 * every agent request with no cache in front of it, so a revocation lands immediately and on every
 * instance, where an "is the owner still active" check would have to be cached to stay off that
 * path and would then lag by its TTL everywhere but the instance that served the disable.
 *
 * This is proved end to end rather than by spying on a call: the admin route and the auth seam read
 * and write the same in-memory `ApiKey` rows here, so the assertion is literally "the key that
 * worked a moment ago is refused now". Everything else is mocked, in the style of
 * tests/lib/apiKeys.test.ts.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const {
  ADMIN_ID,
  OWNER_ID,
  BYSTANDER_ID,
  ORG_ID,
  apiKeyRows,
  userRows,
  writeOrder,
  connectMongo,
  accountDisabledChanged,
  requireAdmin,
  userUpdateOne,
  apiKeyUpdateMany,
} = vi.hoisted(() => {
  // `vi.mock` factories hoist above imports, so these are fixed hex literals rather than
  // `new Types.ObjectId()`.
  const ADMIN_ID = "64b0c0ffee0000000000c001";
  const OWNER_ID = "64b0c0ffee0000000000c002";
  const BYSTANDER_ID = "64b0c0ffee0000000000c003";
  const ORG_ID = "64b0c0ffee0000000000d001";

  type KeyRow = {
    _id: string;
    orgId: string;
    createdByUserId: string;
    name: string;
    prefix: string;
    keyHash: string;
    scopes: string[];
    revokedAt: Date | null;
    isDeleted: boolean;
    useCount: number;
    lastUsedClient: string | null;
  };

  const apiKeyRows: KeyRow[] = [];
  const userRows = new Set<string>();
  /** "revoke" / "disable", in the order the route wrote them. */
  const writeOrder: string[] = [];

  /** Only the operators these two callers actually use. */
  function matches(row: KeyRow, filter: Record<string, unknown>): boolean {
    for (const [field, cond] of Object.entries(filter)) {
      const value = (row as unknown as Record<string, unknown>)[field];
      if (cond && typeof cond === "object" && "$ne" in (cond as Record<string, unknown>)) {
        if (value === (cond as { $ne: unknown }).$ne) return false;
        continue;
      }
      if (cond === null) {
        // Mongo's `field: null` also matches a missing field; so does this.
        if (value !== null && value !== undefined) return false;
        continue;
      }
      if (String(value) !== String(cond)) return false;
    }
    return true;
  }

  const apiKeyUpdateMany = vi.fn(async (filter: Record<string, unknown>, update: { $set: Record<string, unknown> }) => {
    writeOrder.push("revoke");
    let modifiedCount = 0;
    for (const row of apiKeyRows) {
      if (!matches(row, filter)) continue;
      Object.assign(row, update.$set);
      modifiedCount += 1;
    }
    return { matchedCount: modifiedCount, modifiedCount };
  });

  const userUpdateOne = vi.fn(async (filter: { _id: unknown }) => {
    writeOrder.push("disable");
    return { matchedCount: userRows.has(String(filter._id)) ? 1 : 0, modifiedCount: 1 };
  });

  return {
    ADMIN_ID,
    OWNER_ID,
    BYSTANDER_ID,
    ORG_ID,
    apiKeyRows,
    userRows,
    writeOrder,
    connectMongo: vi.fn(async () => undefined),
    accountDisabledChanged: vi.fn(),
    requireAdmin: vi.fn(async () => ({ ok: true as const, userId: ADMIN_ID, email: "staff@lnkdrp.com" })),
    userUpdateOne,
    apiKeyUpdateMany,
  };
});

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/ApiKey", () => ({
  API_KEY_SCOPES: ["read", "write"],
  ApiKeyModel: {
    findOne: (filter: Record<string, unknown>) => ({
      select: () => ({
        lean: async () => {
          for (const row of apiKeyRows) {
            let ok = true;
            for (const [field, cond] of Object.entries(filter)) {
              const value = (row as unknown as Record<string, unknown>)[field];
              if (cond && typeof cond === "object" && "$ne" in (cond as Record<string, unknown>)) {
                if (value === (cond as { $ne: unknown }).$ne) ok = false;
              } else if (String(value) !== String(cond)) {
                ok = false;
              }
              if (!ok) break;
            }
            if (ok) return row;
          }
          return null;
        },
      }),
    }),
    updateMany: apiKeyUpdateMany,
    updateOne: vi.fn(async () => ({ modifiedCount: 0 })),
  },
}));
vi.mock("@/lib/models/User", () => ({
  UserModel: { findOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })), updateOne: userUpdateOne },
  createTempUser: vi.fn(),
  verifyTempUserSecret: vi.fn(() => false),
}));
vi.mock("@/lib/models/Org", () => ({
  OrgModel: { findOne: vi.fn(() => ({ select: () => ({ lean: async () => null }) })), find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })) },
  ensurePersonalOrgForUserId: vi.fn(),
}));
vi.mock("@/lib/models/OrgMembership", () => ({
  OrgMembershipModel: { find: vi.fn(() => ({ select: () => ({ lean: async () => [] }) })), exists: vi.fn(async () => ({ _id: "m1" })) },
}));
vi.mock("@/lib/models/ActivityEvent", () => ({ ActivityEventModel: { create: vi.fn() } }));
vi.mock("@/lib/http/rateLimit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/http/rateLimit")>()),
  rateLimit: vi.fn(async () => ({ ok: true, remaining: 1, retryAfterSec: 0 })),
}));
/**
 * The key owner is a member of the key's workspace throughout: the membership hole is a different
 * finding with its own tests, and mocking it open is what makes this file about the account state
 * and nothing else.
 */
vi.mock("@/lib/gating/actor", () => ({
  accountDisabledChanged,
  isActiveMember: vi.fn(async () => true),
  resolveExistingActor: vi.fn(async () => null),
}));
vi.mock("@/lib/gating/requireAdmin", () => ({ requireAdmin }));

const { DELETE } = await import("@/app/api/admin/data/users/[userId]/route");
const { verifyBearerToken } = await import("@/lib/gating/apiKeyActor");
const { generateApiKeyPlaintext, hashApiKey } = await import("@/lib/agents/apiKeys");

/** A plaintext key, plus the row the database would hold for it. */
function mintKey(params: { ownerId: string; revokedAt?: Date | null; isDeleted?: boolean }): string {
  const plaintext = generateApiKeyPlaintext();
  apiKeyRows.push({
    _id: new Types.ObjectId().toString(),
    orgId: ORG_ID,
    createdByUserId: params.ownerId,
    name: "Claude Code on my laptop",
    prefix: plaintext.slice(0, 12),
    keyHash: hashApiKey(plaintext),
    scopes: ["read", "write"],
    revokedAt: params.revokedAt ?? null,
    isDeleted: params.isDeleted ?? false,
    useCount: 3,
    lastUsedClient: "Claude Code",
  });
  return plaintext;
}

/** The staff request: `DELETE /api/admin/data/users/:userId`. */
async function staffDisable(userId: string): Promise<Response> {
  const request = new Request(`http://localhost/api/admin/data/users/${userId}`, { method: "DELETE" });
  return await DELETE(request, { params: Promise.resolve({ userId }) });
}

/** The row the given key resolves to, for asserting on `revokedAt` directly. */
function rowFor(plaintext: string) {
  const hash = hashApiKey(plaintext);
  return apiKeyRows.find((r) => r.keyHash === hash)!;
}

beforeEach(() => {
  vi.clearAllMocks();
  apiKeyRows.length = 0;
  writeOrder.length = 0;
  userRows.clear();
  userRows.add(OWNER_ID);
  userRows.add(BYSTANDER_ID);
});

describe("staff disabling an account and the keys it minted", () => {
  test("a key that worked a moment ago is refused on the next request", async () => {
    const key = mintKey({ ownerId: OWNER_ID });

    const before = await verifyBearerToken(key);
    expect(before.ok).toBe(true);

    const res = await staffDisable(OWNER_ID);
    expect(res.status).toBe(200);

    const after = await verifyBearerToken(key);
    expect(after.ok).toBe(false);
    // Not `unauthorized` and not `owner_removed`: the key is revoked, which is the one refusal the
    // agent-facing message already explains ("This API key was revoked.").
    expect(after.ok === false && after.code).toBe("key_revoked");
  });

  test("every key that person minted goes, not just the one they last used", async () => {
    const laptop = mintKey({ ownerId: OWNER_ID });
    const ci = mintKey({ ownerId: OWNER_ID });
    const scratch = mintKey({ ownerId: OWNER_ID });

    const res = await staffDisable(OWNER_ID);

    expect(await res.json()).toMatchObject({ ok: true, userId: OWNER_ID, isActive: false, revokedApiKeys: 3 });
    for (const key of [laptop, ci, scratch]) {
      const result = await verifyBearerToken(key);
      expect(result.ok === false && result.code).toBe("key_revoked");
    }
  });

  test("somebody else's keys keep working", async () => {
    const theirs = mintKey({ ownerId: OWNER_ID });
    const bystander = mintKey({ ownerId: BYSTANDER_ID });

    await staffDisable(OWNER_ID);

    expect((await verifyBearerToken(theirs)).ok).toBe(false);
    // The filter is by `createdByUserId`, so a colleague in the same workspace is untouched. If this
    // ever fails, disabling one account took down the workspace's automation with it.
    expect((await verifyBearerToken(bystander)).ok).toBe(true);
  });

  test("a key revoked earlier keeps its original timestamp and is not counted again", async () => {
    const revokedLastWeek = new Date("2026-09-10T00:00:00.000Z");
    const old = mintKey({ ownerId: OWNER_ID, revokedAt: revokedLastWeek });
    mintKey({ ownerId: OWNER_ID });

    const res = await staffDisable(OWNER_ID);

    // `revokedAt: null` in the filter, so the count staff are shown is "keys this action killed",
    // not "keys this person ever had".
    expect(await res.json()).toMatchObject({ revokedApiKeys: 1 });
    expect(rowFor(old).revokedAt).toBe(revokedLastWeek);
  });

  test("the keys are revoked before the account is disabled", async () => {
    mintKey({ ownerId: OWNER_ID });

    await staffDisable(OWNER_ID);

    /**
     * Two writes, no transaction. If the second one fails the residue has to be "keys dead, account
     * still active" — visible and recoverable. The other order leaves a disabled account whose
     * automation still works, which is the bug this file exists for.
     */
    expect(writeOrder).toEqual(["revoke", "disable"]);
  });

  test("the cached session state is dropped, so the browser goes at the same moment", async () => {
    mintKey({ ownerId: OWNER_ID });

    await staffDisable(OWNER_ID);

    // Without this the JWT path keeps answering from `isAccountDisabled`'s cache for its TTL, so
    // the web session outlives the keys by a few seconds.
    expect(accountDisabledChanged).toHaveBeenCalledWith(OWNER_ID);
  });

  test("a userId nobody has is still a 404, and the account row is what decides that", async () => {
    const stranger = "64b0c0ffee0000000000c009";

    const res = await staffDisable(stranger);

    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "User not found" });
  });

  test("a malformed userId is refused before anything is written", async () => {
    const res = await staffDisable("not-an-object-id");

    expect(res.status).toBe(400);
    expect(apiKeyUpdateMany).not.toHaveBeenCalled();
    expect(userUpdateOne).not.toHaveBeenCalled();
  });

  test("a caller who is not staff writes nothing", async () => {
    requireAdmin.mockResolvedValueOnce({ ok: false, status: 401, error: "Not authenticated" } as never);
    const key = mintKey({ ownerId: OWNER_ID });

    const res = await staffDisable(OWNER_ID);

    expect(res.status).toBe(401);
    expect(apiKeyUpdateMany).not.toHaveBeenCalled();
    expect((await verifyBearerToken(key)).ok).toBe(true);
  });
});
