/**
 * Share links service — DTO shape, the "active" rule, and the refusal matrix that every public
 * share route depends on (docs/prds/lnkdrp-multi-links.md).
 *
 * The models are mocked (same style as tests/lib/apiKeys.test.ts): `ShareLinkModel.findOne` and
 * `DocModel.findOne` answer from in-memory arrays, so a test only has to say which rows exist.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const connectMongo = vi.fn(async () => undefined);

/** In-memory rows the mocked models answer from. */
let links: Record<string, unknown>[] = [];
let docs: Record<string, unknown>[] = [];

const docUpdateOne = vi.fn(async () => ({ acknowledged: true }));
const shareLinkCreate = vi.fn(async (payload: Record<string, unknown>) => {
  const row = { _id: new Types.ObjectId(), createdDate: new Date(), viewCount: 0, downloadCount: 0, ...payload };
  links.push(row);
  return { toObject: () => row };
});

/** Match the filters `src/lib/share/links.ts` actually issues against `sharelinks`. */
function matchLink(filter: Record<string, any>): Record<string, unknown> | null {
  const candidates = Array.isArray(filter.$or) ? filter.$or : [filter];
  for (const f of candidates) {
    const hit = links.find((l) => {
      if (f.shareId !== undefined && l.shareId !== f.shareId) return false;
      if (f.docId !== undefined && String(l.docId) !== String(f.docId)) return false;
      if (f._id !== undefined && String(l._id) !== String(f._id)) return false;
      if (f.isDefault !== undefined && Boolean(l.isDefault) !== f.isDefault) return false;
      if (f.archivedAt === null && l.archivedAt) return false;
      return true;
    });
    if (hit) return hit;
  }
  return null;
}

/** Match the filters the service issues against `docs` (by `_id`, or by legacy `shareId`). */
function matchDoc(filter: Record<string, any>): Record<string, unknown> | null {
  return (
    docs.find((d) => {
      if (filter._id !== undefined && String(d._id) !== String(filter._id)) return false;
      if (filter.shareId !== undefined && d.shareId !== filter.shareId) return false;
      return true;
    }) ?? null
  );
}

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: vi.fn((filter: Record<string, unknown>) => ({
      select: () => ({ lean: async () => matchDoc(filter) }),
      lean: async () => matchDoc(filter),
    })),
    updateOne: docUpdateOne,
  },
}));
/** Match the filters `listShareLinks`/`listShareLinksPage` issue for a document's own rows. */
function matchLinks(filter: Record<string, any>): Record<string, unknown>[] {
  return links.filter((l) => {
    if (filter.docId !== undefined && String(l.docId) !== String(filter.docId)) return false;
    if (filter.archivedAt === null && l.archivedAt) return false;
    if (filter.shareId?.$in && !filter.shareId.$in.includes(l.shareId)) return false;
    return true;
  });
}

vi.mock("@/lib/models/ShareLink", () => ({
  ShareLinkModel: {
    findOne: vi.fn((filter: Record<string, unknown>) => ({ lean: async () => matchLink(filter) })),
    // Supports both call shapes the service actually uses: `.find(filter).lean()` (everything,
    // unordered — `listShareLinks`) and `.find(filter).sort(...).skip(n).limit(n).lean()` (one
    // page, in order — `listShareLinksPage`).
    find: vi.fn((filter: Record<string, unknown> = {}) => {
      const rows = matchLinks(filter);
      const withPaging = (sorted: Record<string, unknown>[]) => {
        let skipN = 0;
        let limitN: number | null = null;
        const chain = {
          skip(n: number) {
            skipN = n;
            return chain;
          },
          limit(n: number) {
            limitN = n;
            return chain;
          },
          lean: async () => sorted.slice(skipN, limitN === null ? undefined : skipN + limitN),
        };
        return chain;
      };
      return {
        sort: (spec: Record<string, 1 | -1>) => {
          const keys = Object.entries(spec);
          const sorted = [...rows].sort((a: any, b: any) => {
            for (const [k, dir] of keys) {
              const raw = (v: unknown) => (v instanceof Date ? v.getTime() : typeof v === "boolean" ? Number(v) : (v ?? 0));
              const av = raw(a[k]);
              const bv = raw(b[k]);
              if (av !== bv) return dir === -1 ? (bv as number) - (av as number) : (av as number) - (bv as number);
            }
            return 0;
          });
          return withPaging(sorted);
        },
        lean: async () => rows,
      };
    }),
    countDocuments: vi.fn(async (filter: Record<string, unknown> = {}) => matchLinks(filter).length),
    create: shareLinkCreate,
    findOneAndUpdate: vi.fn(() => ({ lean: async () => null })),
    updateOne: vi.fn(async () => ({ acknowledged: true })),
  },
}));
vi.mock("@/lib/crypto/randomBase62", () => ({ newShareId: () => "generatedSlug1" }));
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit: vi.fn(async () => ({ ok: true, warning: null })) }));

const { DEFAULT_LINK_LABEL, isLinkActive, listShareLinksPage, resolveShareLink, toShareLinkDTO } = await import("@/lib/share/links");

const DOC_ID = new Types.ObjectId();
const ORG_ID = new Types.ObjectId();
const LINK_ID = new Types.ObjectId();

/** A stored ShareLink row, active unless overridden. */
function linkRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: LINK_ID,
    orgId: ORG_ID,
    docId: DOC_ID,
    shareId: "srDP4SzZNA5a",
    label: "Sequoia",
    audience: "Roelof",
    isDefault: false,
    enabled: true,
    allowDownload: false,
    allowRevisionHistory: false,
    expiresAt: null,
    passwordHash: null,
    passwordSalt: null,
    archivedAt: null,
    createdVia: "web",
    createdDate: new Date("2026-09-01T10:00:00.000Z"),
    lastViewedAt: null,
    viewCount: 0,
    downloadCount: 0,
    ...overrides,
  };
}

/** A stored Doc row, live unless overridden. */
function docRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: DOC_ID,
    orgId: ORG_ID,
    userId: new Types.ObjectId(),
    shareId: "srDP4SzZNA5a",
    shareEnabled: true,
    isDeleted: false,
    isArchived: false,
    title: "USAVX MEMO",
    ...overrides,
  };
}

beforeEach(() => {
  links = [];
  docs = [];
  docUpdateOne.mockClear();
  shareLinkCreate.mockClear();
});

describe("isLinkActive", () => {
  test("enabled, unarchived and unexpired is active", () => {
    expect(isLinkActive(linkRow() as never)).toBe(true);
  });

  test("a disabled link is never active", () => {
    expect(isLinkActive(linkRow({ enabled: false }) as never)).toBe(false);
  });

  test("an archived link is never active, even while enabled", () => {
    expect(isLinkActive(linkRow({ archivedAt: new Date() }) as never)).toBe(false);
  });

  test("expiry is evaluated at the instant given, not at import time", () => {
    const expiresAt = new Date("2026-09-10T00:00:00.000Z");
    const link = linkRow({ expiresAt }) as never;
    expect(isLinkActive(link, expiresAt.getTime() - 1)).toBe(true);
    // The expiry instant itself already refuses (`<=`), so a link never serves at its own deadline.
    expect(isLinkActive(link, expiresAt.getTime())).toBe(false);
    expect(isLinkActive(link, expiresAt.getTime() + 1)).toBe(false);
  });
});

describe("toShareLinkDTO", () => {
  test("maps a stored row to the client shape, with dates as ISO strings", () => {
    const dto = toShareLinkDTO(
      linkRow({
        lastViewedAt: new Date("2026-09-12T08:30:00.000Z"),
        viewCount: 7,
        downloadCount: 2,
      }) as never,
    );
    expect(dto).toMatchObject({
      id: String(LINK_ID),
      docId: String(DOC_ID),
      shareId: "srDP4SzZNA5a",
      label: "Sequoia",
      audience: "Roelof",
      isDefault: false,
      enabled: true,
      allowDownload: false,
      allowRevisionHistory: false,
      passwordEnabled: false,
      expiresAt: null,
      active: true,
      status: "active",
      createdVia: "web",
      createdAt: "2026-09-01T10:00:00.000Z",
      lastViewedAt: "2026-09-12T08:30:00.000Z",
      viewCount: 7,
      downloadCount: 2,
    });
  });

  test("never leaks password material, only whether a password is set", () => {
    const dto = toShareLinkDTO(linkRow({ passwordHash: "hash", passwordSalt: "salt" }) as never);
    expect(dto.passwordEnabled).toBe(true);
    expect(JSON.stringify(dto)).not.toContain("hash");
  });

  test("status follows the precedence archived > disabled > expired > active", () => {
    const past = new Date(Date.now() - 1000);
    expect(toShareLinkDTO(linkRow({ archivedAt: new Date(), enabled: false, expiresAt: past }) as never).status).toBe("archived");
    expect(toShareLinkDTO(linkRow({ enabled: false, expiresAt: past }) as never).status).toBe("disabled");
    expect(toShareLinkDTO(linkRow({ expiresAt: past }) as never).status).toBe("expired");
    const active = toShareLinkDTO(linkRow() as never);
    expect(active.status).toBe("active");
    expect(active.active).toBe(true);
  });
});

describe("resolveShareLink refusal matrix", () => {
  test("an empty or unknown slug resolves to nothing at all", async () => {
    expect(await resolveShareLink("")).toBeNull();
    expect(await resolveShareLink("   ")).toBeNull();
    expect(await resolveShareLink("neverExisted")).toBeNull();
  });

  test("a live link on a live document may be served", async () => {
    links = [linkRow()];
    docs = [docRow()];
    const res = await resolveShareLink("srDP4SzZNA5a");
    expect(res?.refusal).toBeNull();
    expect(res?.link.shareId).toBe("srDP4SzZNA5a");
    expect(String(res?.doc._id)).toBe(String(DOC_ID));
  });

  test("a disabled link refuses with `disabled`", async () => {
    links = [linkRow({ enabled: false })];
    docs = [docRow()];
    expect((await resolveShareLink("srDP4SzZNA5a"))?.refusal).toBe("disabled");
  });

  test("a past `expiresAt` refuses with `expired`", async () => {
    links = [linkRow({ expiresAt: new Date(Date.now() - 60_000) })];
    docs = [docRow()];
    expect((await resolveShareLink("srDP4SzZNA5a"))?.refusal).toBe("expired");
  });

  test("a future `expiresAt` still serves", async () => {
    links = [linkRow({ expiresAt: new Date(Date.now() + 60_000) })];
    docs = [docRow()];
    expect((await resolveShareLink("srDP4SzZNA5a"))?.refusal).toBeNull();
  });

  test("an archived link refuses with `archived`", async () => {
    links = [linkRow({ archivedAt: new Date() })];
    docs = [docRow()];
    expect((await resolveShareLink("srDP4SzZNA5a"))?.refusal).toBe("archived");
  });

  test("an archived document refuses every one of its links", async () => {
    links = [linkRow()];
    docs = [docRow({ isArchived: true })];
    expect((await resolveShareLink("srDP4SzZNA5a"))?.refusal).toBe("archived");
  });

  test("a deleted document refuses with `doc_gone`", async () => {
    links = [linkRow()];
    docs = [docRow({ isDeleted: true })];
    expect((await resolveShareLink("srDP4SzZNA5a"))?.refusal).toBe("doc_gone");
  });

  test("a legacy document with no link row gets its default link on first touch", async () => {
    docs = [docRow({ shareAllowPdfDownload: true, sharePasswordHash: "h", sharePasswordSalt: "s" })];
    const res = await resolveShareLink("srDP4SzZNA5a");
    expect(res?.refusal).toBeNull();
    expect(shareLinkCreate).toHaveBeenCalledTimes(1);
    // The link inherits the document's settings, so nothing changes for recipients on migration day.
    expect(res?.link).toMatchObject({
      shareId: "srDP4SzZNA5a",
      label: DEFAULT_LINK_LABEL,
      isDefault: true,
      enabled: true,
      allowDownload: true,
      passwordHash: "h",
      passwordSalt: "s",
      createdVia: "migration",
    });
    // The document already had a slug, so it is not rewritten.
    expect(docUpdateOne).not.toHaveBeenCalled();
  });

  test("the lazily created default link of a disabled document is disabled too", async () => {
    docs = [docRow({ shareEnabled: false })];
    const res = await resolveShareLink("srDP4SzZNA5a");
    expect(res?.link.enabled).toBe(false);
    expect(res?.refusal).toBe("disabled");
  });
});

describe("listShareLinksPage", () => {
  /**
   * `mt_...` — a document can carry hundreds of links; this is the one place that must never hand
   * back "every link" the way `listShareLinks` still does for its internal, non-paginated callers.
   * Real pagination (`sort`+`skip`+`limit` in the mock, mirroring Mongo) so an off-by-one in the
   * service can't hide behind a mock that always returns everything anyway.
   */
  test("total counts every link; the page only ever returns `limit` of them", async () => {
    docs = [docRow()];
    links = [
      linkRow({ _id: new Types.ObjectId(), shareId: "default000001", isDefault: true, createdDate: new Date("2026-01-01") }),
      ...Array.from({ length: 24 }, (_, i) =>
        linkRow({ _id: new Types.ObjectId(), shareId: `link${String(i).padStart(9, "0")}`, isDefault: false, createdDate: new Date(2026, 0, 2 + i) }),
      ),
    ];
    const page1 = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, page: 1, limit: 10 });
    expect(page1.total).toBe(25);
    expect(page1.page).toBe(1);
    expect(page1.limit).toBe(10);
    expect(page1.links).toHaveLength(10);
  });

  test("the default link leads page 1 regardless of how old it is", async () => {
    docs = [docRow()];
    links = [
      linkRow({ _id: new Types.ObjectId(), shareId: "old000000001", isDefault: false, createdDate: new Date("2026-09-01") }),
      linkRow({ _id: new Types.ObjectId(), shareId: "newest000001", isDefault: false, createdDate: new Date("2026-09-10") }),
      linkRow({ _id: new Types.ObjectId(), shareId: "default000001", isDefault: true, createdDate: new Date("2026-01-01") }),
    ];
    const page = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, page: 1, limit: 10 });
    expect(page.links.map((l) => l.shareId)).toEqual(["default000001", "newest000001", "old000000001"]);
  });

  test("page 2 is the next slice, with no row repeated from page 1", async () => {
    docs = [docRow()];
    links = [
      linkRow({ _id: new Types.ObjectId(), shareId: "default000001", isDefault: true, createdDate: new Date("2026-01-01") }),
      ...Array.from({ length: 11 }, (_, i) =>
        linkRow({ _id: new Types.ObjectId(), shareId: `link${String(i).padStart(9, "0")}`, isDefault: false, createdDate: new Date(2026, 0, 2 + i) }),
      ),
    ];
    const page1 = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, page: 1, limit: 5 });
    const page2 = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, page: 2, limit: 5 });
    expect(page1.links).toHaveLength(5);
    expect(page2.links).toHaveLength(5);
    const page1Ids = new Set(page1.links.map((l) => l.shareId));
    for (const l of page2.links) expect(page1Ids.has(l.shareId)).toBe(false);
  });

  test("a page past the end is simply empty, not an error, and total still reports the real count", async () => {
    docs = [docRow()];
    links = [linkRow({ isDefault: true })];
    const page = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, page: 50, limit: 25 });
    expect(page.total).toBe(1);
    expect(page.links).toHaveLength(0);
  });

  test("archived links are excluded from both the page and the total unless asked for", async () => {
    docs = [docRow()];
    links = [
      linkRow({ isDefault: true }),
      linkRow({ _id: new Types.ObjectId(), shareId: "archived00001", archivedAt: new Date() }),
    ];
    const live = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID });
    expect(live.total).toBe(1);
    const withArchived = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, includeArchived: true });
    expect(withArchived.total).toBe(2);
  });

  test("limit clamps to 100 and page to 1, so a hostile query string cannot ask for everything", async () => {
    docs = [docRow()];
    links = [linkRow({ isDefault: true })];
    const page = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, page: 0, limit: 10_000 });
    expect(page.page).toBe(1);
    expect(page.limit).toBe(100);
  });

  test("an unknown document returns an empty page rather than throwing", async () => {
    docs = [];
    links = [];
    const page = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID });
    expect(page).toEqual({ total: 0, page: 1, limit: 25, links: [] });
  });
});
