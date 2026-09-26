/**
 * The public resolvers ask for the password fields, and what they hand back locks the gate.
 *
 * `ShareLink.password*` is `select: false` (tests/lib/sharePasswordSelect.test.ts pins the schema),
 * which makes `resolveShareLink` and `resolveProjectLink` the two reads that must opt back in: every
 * `/s/` and `/p/` route, the unlock endpoint and the download-token chain gate on the row they
 * return. So the assertion here is on the query itself: the link lookup is issued with a projection
 * that names `+passwordHash` and `+passwordSalt`, and the row that comes back, put through the real
 * `shareLinkUnlocked`, refuses a request with no cookie.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const { connectMongo, linkFindOne, docFindOne, projectFindOne } = vi.hoisted(() => ({
  connectMongo: vi.fn(async () => undefined),
  linkFindOne: vi.fn(),
  docFindOne: vi.fn(),
  projectFindOne: vi.fn(),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/ShareLink", async () => {
  const actual = await vi.importActual<typeof import("@/lib/models/ShareLink")>("@/lib/models/ShareLink");
  return {
    DOC_LINK_FILTER: actual.DOC_LINK_FILTER,
    PROJECT_LINK_FILTER: actual.PROJECT_LINK_FILTER,
    ShareLinkModel: { findOne: linkFindOne },
  };
});
vi.mock("@/lib/models/Doc", () => ({ DocModel: { findOne: docFindOne, updateOne: vi.fn() } }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: { findOne: projectFindOne, updateOne: vi.fn() } }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { aggregate: vi.fn(async () => []) } }));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn() }));
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit: vi.fn(async () => ({ ok: true, warning: null })) }));

const { resolveShareLink, shareLinkUnlocked } = await import("@/lib/share/links");
const { resolveProjectLink } = await import("@/lib/share/projectLinks");
const { SHARE_LINK_PASSWORD_FIELDS } = await import("@/lib/share/passwordSelect");

const SHARE_ID = "srDP4SzZNA5a";
const DOC_ID = new Types.ObjectId();
const PROJECT_ID = new Types.ObjectId();
const ORG_ID = new Types.ObjectId();

/** A stored link row, with the material the opted-in read returns. */
function lockedRow(owner: { docId: Types.ObjectId } | { projectId: Types.ObjectId }) {
  return {
    _id: new Types.ObjectId(),
    orgId: ORG_ID,
    docId: null,
    projectId: null,
    ...owner,
    shareId: SHARE_ID,
    label: "Sequoia",
    isDefault: true,
    enabled: true,
    archivedAt: null,
    expiresAt: null,
    passwordHash: "qN0tArEaLhAsH",
    passwordSalt: "saltysalt",
  };
}

/** The lookup's projection argument, as a normalised list of the `+fields` it opts in to. */
function optedIn(call: unknown[]): string[] {
  const projection = call[1];
  if (typeof projection === "string") return projection.split(/\s+/).filter(Boolean);
  if (projection && typeof projection === "object") return Object.keys(projection);
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
  docFindOne.mockReturnValue({
    select: () => ({ lean: async () => ({ _id: DOC_ID, orgId: ORG_ID, shareId: SHARE_ID, isDeleted: false, isArchived: false }) }),
  });
  projectFindOne.mockReturnValue({
    select: () => ({ lean: async () => ({ _id: PROJECT_ID, orgId: ORG_ID, shareId: SHARE_ID, isDeleted: false }) }),
  });
});

const req = () => new Request("https://lnkdrp.test/x");

describe("resolveShareLink", () => {
  test("looks the link up with every password field opted in, and the row it returns refuses the gate", async () => {
    linkFindOne.mockReturnValue({ lean: async () => lockedRow({ docId: DOC_ID }) });

    const resolved = await resolveShareLink(SHARE_ID);
    expect(resolved?.refusal).toBeNull();

    expect(linkFindOne).toHaveBeenCalledTimes(1);
    const fields = optedIn(linkFindOne.mock.calls[0] as unknown[]);
    for (const f of SHARE_LINK_PASSWORD_FIELDS) expect(fields).toContain(`+${f}`);

    expect(resolved?.link.passwordHash).toBe("qN0tArEaLhAsH");
    expect(shareLinkUnlocked(req(), SHARE_ID, resolved!.link)).toBe(false);
  });
});

describe("resolveProjectLink", () => {
  test("looks the link up with every password field opted in, and the row it returns refuses the gate", async () => {
    linkFindOne.mockReturnValue({ lean: async () => lockedRow({ projectId: PROJECT_ID }) });

    const resolved = await resolveProjectLink(SHARE_ID);
    expect(resolved?.refusal).toBeNull();

    expect(linkFindOne).toHaveBeenCalledTimes(1);
    const fields = optedIn(linkFindOne.mock.calls[0] as unknown[]);
    for (const f of SHARE_LINK_PASSWORD_FIELDS) expect(fields).toContain(`+${f}`);

    expect(resolved?.link.passwordHash).toBe("qN0tArEaLhAsH");
    expect(shareLinkUnlocked(req(), SHARE_ID, resolved!.link)).toBe(false);
  });
});
