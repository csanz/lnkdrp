/**
 * `ensureDefaultLink` on a document that predates workspaces — the case `/s/:shareId` used to 500 on.
 *
 * `ShareLink.orgId` is `required: true`, and the service passed `doc.orgId ?? undefined` straight
 * into `create`. For a pre-workspaces document (no `orgId`, only a `userId` — the row
 * `buildDocMatch`'s `allowLegacyByUserId` serves and `scripts/sharelinks-backfill.ts` skips) the
 * create was rejected by the validator, the catch found no existing row to fall back on and
 * rethrew, and the throw escaped `resolveShareLink` onto the public page. A stranger holding a
 * perfectly good link got the error boundary: neither served nor refused.
 *
 * This lives beside `tests/lib/shareLinks.test.ts` rather than inside it because it needs one mock
 * that suite deliberately does not have: a `create` that *enforces* the required `orgId`, so the
 * regression can actually fail here instead of sailing past a permissive stub.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

/** In-memory rows the mocked models answer from. */
let links: Record<string, unknown>[] = [];
let docs: Record<string, unknown>[] = [];

const docUpdateOne = vi.fn(async (filter: Record<string, any>, update: Record<string, any>) => {
  const hit = docs.find((d) => String(d._id) === String(filter._id));
  if (hit) Object.assign(hit, update.$set ?? {});
  return { acknowledged: true };
});

/**
 * Stands in for the schema, not for a happy path: `orgId` is `required: true` in
 * `src/lib/models/ShareLink.ts`, so a create without one must reject exactly as Mongoose would.
 */
const shareLinkCreate = vi.fn(async (payload: Record<string, unknown>) => {
  if (!payload.orgId) throw new Error("ShareLink validation failed: orgId: Path `orgId` is required.");
  const row = { _id: new Types.ObjectId(), createdDate: new Date(), viewCount: 0, downloadCount: 0, ...payload };
  links.push(row);
  return { toObject: () => row };
});

function matchLink(filter: Record<string, any>): Record<string, unknown> | null {
  const candidates = Array.isArray(filter.$or) ? filter.$or : [filter];
  for (const f of candidates) {
    const hit = links.find((l) => {
      if (f.shareId !== undefined && l.shareId !== f.shareId) return false;
      if (f.docId !== undefined && String(l.docId) !== String(f.docId)) return false;
      if (f.isDefault !== undefined && Boolean(l.isDefault) !== f.isDefault) return false;
      return true;
    });
    if (hit) return hit;
  }
  return null;
}

function matchDoc(filter: Record<string, any>): Record<string, unknown> | null {
  return (
    docs.find((d) => {
      if (filter._id !== undefined && String(d._id) !== String(filter._id)) return false;
      if (filter.shareId !== undefined && d.shareId !== filter.shareId) return false;
      return true;
    }) ?? null
  );
}

const ensurePersonalOrgForUserId = vi.fn(async (_opts: { userId: Types.ObjectId }) => ({ orgId: PERSONAL_ORG_ID }));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId }));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: vi.fn((filter: Record<string, unknown>) => ({
      select: () => ({ lean: async () => matchDoc(filter) }),
      lean: async () => matchDoc(filter),
    })),
    updateOne: docUpdateOne,
  },
}));
vi.mock("@/lib/models/ShareLink", () => ({
  DOC_LINK_FILTER: { kind: { $ne: "project" } },
  ShareLinkModel: {
    findOne: vi.fn((filter: Record<string, unknown>) => ({ lean: async () => matchLink(filter) })),
    find: vi.fn(() => ({ lean: async () => links })),
    countDocuments: vi.fn(async () => links.length),
    create: shareLinkCreate,
    findOneAndUpdate: vi.fn(() => ({ lean: async () => null })),
    updateOne: vi.fn(async () => ({ acknowledged: true })),
  },
}));
vi.mock("@/lib/crypto/randomBase62", () => ({ newShareId: () => "generatedSlug1" }));
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit: vi.fn(async () => ({ ok: true, warning: null })) }));

const { resolveShareLink } = await import("@/lib/share/links");

const DOC_ID = new Types.ObjectId();
const USER_ID = new Types.ObjectId();
const PERSONAL_ORG_ID = new Types.ObjectId();

/** A document written before workspaces existed: an owner, a slug, and no `orgId` at all. */
function legacyDocRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: DOC_ID,
    orgId: null,
    userId: USER_ID,
    shareId: "srDP4SzZNA5a",
    shareEnabled: true,
    shareAllowPdfDownload: true,
    isDeleted: false,
    isArchived: false,
    title: "PRE-WORKSPACES MEMO",
    ...overrides,
  };
}

beforeEach(() => {
  links = [];
  docs = [];
  docUpdateOne.mockClear();
  shareLinkCreate.mockClear();
  ensurePersonalOrgForUserId.mockClear();
});

describe("resolveShareLink on a pre-workspaces document", () => {
  test("adopts the document into its owner's personal workspace instead of throwing", async () => {
    docs = [legacyDocRow()];
    const res = await resolveShareLink("srDP4SzZNA5a");
    // The whole point: a link, not an exception.
    expect(res).not.toBeNull();
    expect(res?.refusal).toBeNull();
    expect(res?.link.shareId).toBe("srDP4SzZNA5a");
    // The link hangs on the owner's personal org, which is the only workspace the row can belong to.
    expect(String(res?.link.orgId)).toBe(String(PERSONAL_ORG_ID));
    expect(ensurePersonalOrgForUserId).toHaveBeenCalledWith({ userId: USER_ID });
    // Settings still come from the document, exactly as for a document that already had an org.
    expect(res?.link).toMatchObject({ isDefault: true, enabled: true, allowDownload: true, createdVia: "migration" });
  });

  test("writes the adopted workspace back onto the document, so it happens once", async () => {
    docs = [legacyDocRow()];
    await resolveShareLink("srDP4SzZNA5a");
    expect(docUpdateOne).toHaveBeenCalledWith({ _id: DOC_ID }, { $set: { orgId: PERSONAL_ORG_ID } });
    expect(docs[0].orgId).toBe(PERSONAL_ORG_ID);
  });

  test("a document with neither workspace nor owner is a miss, not an error", async () => {
    // Nothing to adopt it into. The slug is real, but there is no workspace to hang a link on, so
    // the public route must get a null (404) rather than a throw it renders as the error boundary.
    docs = [legacyDocRow({ userId: null })];
    await expect(resolveShareLink("srDP4SzZNA5a")).resolves.toBeNull();
    expect(shareLinkCreate).not.toHaveBeenCalled();
  });

  test("a failure to resolve the personal workspace is still a miss, never a 500", async () => {
    ensurePersonalOrgForUserId.mockRejectedValueOnce(new Error("mongo is down"));
    docs = [legacyDocRow()];
    await expect(resolveShareLink("srDP4SzZNA5a")).resolves.toBeNull();
    expect(shareLinkCreate).not.toHaveBeenCalled();
  });
});
