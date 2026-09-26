/**
 * Who `GET /api/docs/:docId` may hand `replaceUploadToken` to.
 *
 * The token is a bearer capability, not metadata. `POST /api/replace/:token/uploads` accepts it
 * with no session at all, returns an `uploadSecret`, and that secret installs a new PDF as the
 * current version of a document every recipient of the share link is already reading. Nothing in
 * the codebase rotates or revokes the token, so reading it once is the document-edit right for
 * ever.
 *
 * The route handed it to anyone with a membership row:
 *
 * - a `viewer`, whose PATCH on the very same document is refused by `requireOrgRole({ minRole:
 *   "member" })` — so the read-only member simply replaced the file through the public route and
 *   the member gate was decoration;
 * - any API key, `read`-scope included. That one compounds: the key is revocable and the token is
 *   not, so a leaked read-only key left a permanent write capability behind after it was revoked —
 *   the self-perpetuating shape `src/lib/gating/forbidApiKey.ts` was written to end.
 *
 * `requireOrgRole` runs for real here against a mocked membership collection; stubbing its answer
 * would leave the actual question — does the route ask about the role at all — untested.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

const {
  ORG_ID,
  USER_ID,
  DOC_ID,
  REQUEST_PROJECT_ID,
  TOKEN,
  MINTED_TOKEN,
  connectMongo,
  docFindOne,
  docUpdateOne,
  membershipFindOne,
  orgExists,
  projectFindOne,
  newSecretToken,
  actor,
} = vi.hoisted(() => {
  const ORG_ID = "64b0c0ffee0000000000e001";
  const USER_ID = "64b0c0ffee0000000000e002";
  const DOC_ID = "64b0c0ffee0000000000e003";
  const REQUEST_PROJECT_ID = "64b0c0ffee0000000000e004";
  return {
    ORG_ID,
    USER_ID,
    DOC_ID,
    REQUEST_PROJECT_ID,
    TOKEN: "Zk39aQ7xLm02PdR4sT61uVwX",
    MINTED_TOKEN: "mintedTokenForThisDoc0001",
    connectMongo: vi.fn(async () => undefined),
    docFindOne: vi.fn(),
    docUpdateOne: vi.fn(async () => ({ modifiedCount: 1 })),
    membershipFindOne: vi.fn(),
    orgExists: vi.fn(async () => null as unknown),
    projectFindOne: vi.fn(),
    newSecretToken: vi.fn(() => "mintedTokenForThisDoc0001"),
    actor: { current: {} as Record<string, unknown> },
  };
});

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: { findOne: docFindOne, updateOne: docUpdateOne, findOneAndUpdate: vi.fn(), deleteOne: vi.fn() },
}));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { findOne: projectFindOne, find: vi.fn() } }));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: { findById: vi.fn(), findOne: vi.fn(), find: vi.fn(), updateOne: vi.fn() },
}));
vi.mock("@/lib/models/User", () => ({ UserModel: { findById: vi.fn() } }));
vi.mock("@/lib/models/OrgMembership", () => ({ OrgMembershipModel: { findOne: membershipFindOne } }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { exists: orgExists } }));
vi.mock("@/lib/debug", () => ({ debugEnabled: () => false, debugError: vi.fn(), debugLog: vi.fn() }));
vi.mock("@/lib/gating/actor", () => ({
  applyTempUserHeaders: (res: Response) => res,
  resolveActor: vi.fn(async () => actor.current),
  tryResolveUserActorFastWithPersonalOrg: vi.fn(async () => actor.current),
}));
vi.mock("@/lib/crypto/randomBase62", () => ({
  randomBase62: vi.fn(() => "abc"),
  newShareId: vi.fn(() => "shareIdAbc12"),
  newSecretToken,
}));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit: vi.fn(), planLimitResponse: vi.fn() }));
vi.mock("@/lib/share/links", () => ({
  ensureDefaultLink: vi.fn(),
  setAllLinksEnabled: vi.fn(),
  updateShareLink: vi.fn(),
}));
vi.mock("@/lib/docs/docMatch", () => ({ buildDocMatch: vi.fn(() => ({ _id: "doc" })) }));
/**
 * No locked rooms in this fixture (docs/prds/lnkdrp-locked-projects.md, decision 11).
 *
 * The by-id document match now carries an exclusion the caller computes, so without this the handler
 * would go looking for the projects collection. An empty hidden set makes the exclusion `{}`, which is
 * the state a workspace with no private room is really in, so every filter asserted below is the one it
 * was written against. The clause itself is pinned in `tests/lib/lockedProjectSurfaces.test.ts`.
 */
vi.mock("@/lib/projects/lockScope", () => ({
  hiddenProjectIds: async () => [],
  lockedHomeExclusion: () => ({}),
  lockedHomeExclusionFor: async () => ({}),
  projectGrantIds: async () => [],
  projectVisibilityClause: () => ({ $or: [{ visibility: { $ne: "locked" } }, { _id: { $in: [] } }] }),
}));
vi.mock("@/lib/tags/service", () => ({ removeAllTagsFromTarget: vi.fn() }));

const { GET } = await import("@/app/api/docs/[docId]/route");

/** A document received through a request link: the only kind that carries the token. */
function requestDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: DOC_ID,
    orgId: ORG_ID,
    userId: USER_ID,
    shareId: "shareIdAbc12",
    title: "Q3 numbers",
    status: "ready",
    receivedViaRequestProjectId: REQUEST_PROJECT_ID,
    replaceUploadToken: "Zk39aQ7xLm02PdR4sT61uVwX",
    sharePasswordHash: "a-hash",
    sharePasswordEnc: "an-encrypted-password",
    ...overrides,
  };
}

function docQuery(doc: unknown) {
  return { select: () => docQuery(doc), lean: async () => doc };
}

function asRole(role: string | null) {
  membershipFindOne.mockReturnValue({ select: () => ({ lean: async () => (role ? { role } : null) }) });
}

async function getDoc(query = "") {
  const res = await GET(new Request(`https://lnkdrp.test/api/docs/${DOC_ID}${query}`), {
    params: Promise.resolve({ docId: DOC_ID }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

beforeEach(() => {
  vi.clearAllMocks();
  actor.current = { kind: "user", userId: USER_ID, orgId: ORG_ID, personalOrgId: "64b0c0ffee0000000000e009" };
  docFindOne.mockImplementation(() => docQuery(requestDoc()));
  docUpdateOne.mockResolvedValue({ modifiedCount: 1 });
  projectFindOne.mockReturnValue({ select: () => ({ lean: async () => null }) });
  orgExists.mockResolvedValue(null);
  newSecretToken.mockReturnValue(MINTED_TOKEN);
});

describe("GET /api/docs/:docId — replaceUploadToken", () => {
  test("a viewer reads the document but is not handed the capability", async () => {
    asRole("viewer");
    const { status, body } = await getDoc();
    expect(status).toBe(200);
    // The read itself is allowed — a viewer is a member of the workspace.
    expect(body.doc.id).toBe(DOC_ID);
    expect(body.doc.replaceUploadToken).toBeNull();
    // Nowhere else in the payload either.
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  test("a member is handed it: replacing a document is the member-level right", async () => {
    asRole("member");
    const { body } = await getDoc();
    expect(body.doc.replaceUploadToken).toBe(TOKEN);
  });

  test("an owner is handed it", async () => {
    asRole("owner");
    expect((await getDoc()).body.doc.replaceUploadToken).toBe(TOKEN);
  });

  test("an API key never is, however well-scoped, because the token outlives revoking the key", async () => {
    asRole("owner");
    actor.current = { ...actor.current, viaApiKey: { keyId: "key_1", scopes: ["read", "write"] } };
    const { body } = await getDoc();
    expect(body.doc.replaceUploadToken).toBeNull();
    expect(JSON.stringify(body)).not.toContain(TOKEN);
  });

  test("a viewer's read does not mint a token on a document that has none", async () => {
    asRole("viewer");
    docFindOne.mockImplementation(() => docQuery(requestDoc({ replaceUploadToken: null })));
    const { body } = await getDoc();
    expect(body.doc.replaceUploadToken).toBeNull();
    // Minting here would create a permanent write capability over a document the caller may not
    // edit, and leave it lying in the row for whoever asks next.
    expect(newSecretToken).not.toHaveBeenCalled();
    expect(docUpdateOne).not.toHaveBeenCalled();
  });

  test("a member's read still backfills the token for a request document that lacks one", async () => {
    asRole("member");
    docFindOne.mockImplementation(() => docQuery(requestDoc({ replaceUploadToken: null })));
    const { body } = await getDoc();
    expect(newSecretToken).toHaveBeenCalled();
    expect(body.doc.replaceUploadToken).toBe(MINTED_TOKEN);
  });

  test("the `?debug=1` raw-row snapshot carries neither the token nor the share-password material", async () => {
    asRole("owner");
    const { body } = await getDoc("?debug=1");
    expect(body.debug?.enabled).toBe(true);
    // The shaped fields above are gated; the raw row must not be a way around them.
    expect(body.debug.doc.replaceUploadToken).toBeUndefined();
    expect(body.debug.doc.sharePasswordEnc).toBeUndefined();
    expect(body.debug.doc.sharePasswordHash).toBeUndefined();
    expect(JSON.stringify(body.debug)).not.toContain("an-encrypted-password");
  });
});
