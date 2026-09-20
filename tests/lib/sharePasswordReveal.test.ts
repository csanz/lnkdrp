/**
 * `GET /api/docs/:docId/share-password` reports whether a password is set. It never reveals one.
 *
 * It used to. The handler decrypted `sharePasswordEnc` and returned the plaintext to anyone with a
 * membership row in the workspace — every role, `viewer` included, the read-only seat given to
 * outside reviewers — with no rate limit and no activity row, so walking the ids from `GET
 * /api/docs` collected the password for every protected link in the workspace and left no trace.
 *
 * The fix was to delete the reveal rather than gate it. There is one way to read a share password
 * back out, `GET /api/docs/:docId/links/:linkId/password`: admin-or-owner, rate-limited, refuses
 * deleted links, and writes `share_link.password_revealed`. A second reveal path is by definition
 * the one that drifts out of step, and this one already had.
 *
 * Both halves are pinned here: the response never carries the plaintext, and the query never even
 * loads the encrypted material, so a future edit to the response shape cannot put it back by
 * accident.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const { ORG_ID, USER_ID, DOC_ID, connectMongo, docFindOne, decryptSharePassword, actor } = vi.hoisted(() => {
  const ORG_ID = "64b0c0ffee0000000000d001";
  const USER_ID = "64b0c0ffee0000000000d002";
  const DOC_ID = "64b0c0ffee0000000000d003";
  return {
    ORG_ID,
    USER_ID,
    DOC_ID,
    connectMongo: vi.fn(async () => undefined),
    docFindOne: vi.fn(),
    decryptSharePassword: vi.fn(() => "hunter2"),
    actor: {
      current: {
        kind: "user",
        userId: USER_ID,
        orgId: ORG_ID,
        personalOrgId: ORG_ID,
      } as Record<string, unknown>,
    },
  };
});

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { findOne: docFindOne, findOneAndUpdate: vi.fn() } }));
vi.mock("@/lib/gating/actor", () => ({
  applyTempUserHeaders: (res: Response) => res,
  resolveActor: vi.fn(async () => actor.current),
  tryResolveUserActorFastWithPersonalOrg: vi.fn(async () => actor.current),
}));
vi.mock("@/lib/sharePassword", () => ({
  decryptSharePassword,
  encryptSharePassword: vi.fn(() => ({ enc: "enc", iv: "iv", tag: "tag" })),
  hashSharePassword: vi.fn(() => ({ salt: "salt", hash: "hash" })),
}));
vi.mock("@/lib/share/links", () => ({ ensureDefaultLink: vi.fn(), updateShareLink: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/errors/logger", () => ({ logErrorEvent: vi.fn(), ERROR_CODE_UNHANDLED_EXCEPTION: "unhandled" }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/orgs/requireOrgEditor", () => ({ forbidUnlessOrgRole: vi.fn(async () => null) }));

const { GET } = await import("@/app/api/docs/[docId]/share-password/route");

/** The row as it really is in Mongo for a protected link: hash, salt and the reversible copy. */
const PROTECTED_DOC = {
  _id: DOC_ID,
  sharePasswordHash: "a-hash",
  sharePasswordSalt: "a-salt",
  sharePasswordEnc: "an-encrypted-password",
  sharePasswordEncIv: "an-iv",
  sharePasswordEncTag: "a-tag",
};

/** Records the projection the route asked for, so we can assert on what it loads. */
let lastSelect: Record<string, unknown> | null = null;

function docRow(doc: unknown) {
  return {
    select: (projection: Record<string, unknown>) => {
      lastSelect = projection;
      return { lean: async () => doc };
    },
  };
}

function get(query = "") {
  return GET(new Request(`https://lnkdrp.test/api/docs/${DOC_ID}/share-password${query}`), {
    params: Promise.resolve({ docId: DOC_ID }),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  lastSelect = null;
  actor.current = { kind: "user", userId: USER_ID, orgId: ORG_ID, personalOrgId: ORG_ID };
  docFindOne.mockReturnValue(docRow(PROTECTED_DOC));
});

describe("GET /api/docs/:docId/share-password", () => {
  test("a document with a password reports it as enabled and hands back nothing readable", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ sharePasswordEnabled: true, password: null });
  });

  test("the plaintext is never decrypted, so it cannot be leaked by a later change of shape", async () => {
    await get();
    expect(decryptSharePassword).not.toHaveBeenCalled();
  });

  test("the encrypted material is not even selected from the collection", async () => {
    await get();
    expect(lastSelect).toEqual({ sharePasswordHash: 1 });
    for (const field of ["sharePasswordEnc", "sharePasswordEncIv", "sharePasswordEncTag", "sharePasswordSalt"]) {
      expect(lastSelect).not.toHaveProperty(field);
    }
  });

  test("`lite=1` was the only branch that withheld it; dropping the flag no longer changes the answer", async () => {
    // The live reproduction was plain `GET` with no query at all. Both spellings now agree.
    const withFlag = await (await get("?lite=1")).json();
    const without = await (await get()).json();
    expect(withFlag).toEqual(without);
    expect(withFlag.password).toBeNull();
  });

  test("a document with no password reports disabled", async () => {
    docFindOne.mockReturnValue(docRow({ _id: DOC_ID }));
    expect(await (await get()).json()).toEqual({ sharePasswordEnabled: false, password: null });
  });

  test("a document outside the caller's workspace is still a 404, not a 403 that confirms it exists", async () => {
    docFindOne.mockReturnValue(docRow(null));
    expect((await get()).status).toBe(404);
  });

  test("the answer is never cached: a password state is not shared between viewers", async () => {
    expect((await get()).headers.get("cache-control")).toBe("no-store");
  });
});
