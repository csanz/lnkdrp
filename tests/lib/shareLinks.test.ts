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
  // The real fragment, not a stand-in: every write path in the service carries it, and a mock that
  // dropped it would let a test pass against a query the database would have scoped differently.
  DOC_LINK_FILTER: { kind: { $ne: "project" } },
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

const {
  DEFAULT_LINK_LABEL,
  createShareLink,
  isLinkActive,
  listShareLinksPage,
  resolveShareLink,
  setAllLinksEnabled,
  toShareLinkDTO,
  updateShareLink,
} = await import("@/lib/share/links");
const { checkLimit } = await import("@/lib/billing/planLimits");
const { ShareLinkModel } = await import("@/lib/models/ShareLink");

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

  // mt_9ceLy7DqEr. The mock can't simulate real $text relevance (there is no text-search engine
  // behind it), so these only pin the wiring — always page 1, total === the row count returned,
  // still scoped to this document and still excluding archived links — not the ranking itself,
  // which is verified live against a real MongoDB text index instead.
  describe("query (full-text search)", () => {
    test("a query still scopes to this document and reports page 1", async () => {
      docs = [docRow()];
      links = [linkRow({ isDefault: true, label: "Default link" }), linkRow({ _id: new Types.ObjectId(), shareId: "seq0000001", label: "Sequoia" })];
      const page = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, query: "Sequoia" });
      expect(page.page).toBe(1);
      expect(page.total).toBe(page.links.length);
      expect(page.links.every((l) => String(l.docId) === String(DOC_ID))).toBe(true);
    });

    test("a query still excludes archived links unless includeArchived is set", async () => {
      docs = [docRow()];
      links = [
        linkRow({ isDefault: true }),
        linkRow({ _id: new Types.ObjectId(), shareId: "arch0000001", label: "Old Sequoia", archivedAt: new Date() }),
      ];
      const page = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, query: "Sequoia" });
      expect(page.links.some((l) => l.shareId === "arch0000001")).toBe(false);
      const withArchived = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, query: "Sequoia", includeArchived: true });
      expect(withArchived.links.some((l) => l.shareId === "arch0000001")).toBe(true);
    });

    test("an empty or whitespace-only query is treated as no query", async () => {
      docs = [docRow()];
      links = [linkRow({ isDefault: true }), linkRow({ _id: new Types.ObjectId(), shareId: "other00001" })];
      const page = await listShareLinksPage({ orgId: ORG_ID, docId: DOC_ID, query: "   " });
      // Falls through to the plain listing, default-first — not the (empty-filter) search branch.
      expect(page.total).toBe(2);
      expect(page.links[0]?.isDefault).toBe(true);
    });
  });
});

/**
 * The document-level share switch, and the one thing it must never do: hand a revoked recipient
 * their URL back.
 *
 * A default link cannot be deleted — `archiveShareLink` says so — so disabling it *is* how an owner
 * revokes that audience. The switch then had to tell its own disables from the owner's, and the
 * rule it used ("nothing is marked and nothing is enabled → this is a legacy document, restore
 * everything") could not: a document whose every link the owner had revoked by hand looks exactly
 * like that. Turning sharing back on re-enabled the revoked link, at its original slug, silently.
 */
describe("setAllLinksEnabled", () => {
  type Write = { id: string; set: Record<string, unknown> };

  /** The link writes the switch actually issued, in order. */
  function writes(): Write[] {
    const calls = (ShareLinkModel.findOneAndUpdate as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    return calls.map((c) => ({
      id: String((c[0] as { _id: unknown })._id),
      set: (c[1] as { $set: Record<string, unknown> }).$set,
    }));
  }

  const OTHER_LINK = new Types.ObjectId();

  beforeEach(() => {
    (ShareLinkModel.findOneAndUpdate as unknown as { mockClear: () => void }).mockClear();
  });

  test("a link the owner revoked by hand stays revoked when sharing is turned back on", async () => {
    // Exactly the reported sequence: one default link, revoked with `PATCH .../links/:id
    // {enabled:false}` (so `disabledByDocSwitch` is false), then `PATCH /api/docs/:id
    // {shareEnabled:true}`.
    docs = [docRow({ shareEnabled: false })];
    links = [linkRow({ isDefault: true, enabled: false, disabledByDocSwitch: false })];

    const res = await setAllLinksEnabled({ orgId: ORG_ID, docId: DOC_ID, enabled: true });

    expect(res.changed).toBe(0);
    expect(writes()).toEqual([]);
  });

  test("a link the switch itself turned off is restored", async () => {
    docs = [docRow({ shareEnabled: false })];
    links = [linkRow({ isDefault: true, enabled: false, disabledByDocSwitch: true })];

    const res = await setAllLinksEnabled({ orgId: ORG_ID, docId: DOC_ID, enabled: true });

    expect(res.changed).toBe(1);
    expect(writes()).toEqual([{ id: String(LINK_ID), set: { enabled: true, disabledByDocSwitch: false } }]);
  });

  test("with both kinds off, only the switch's own link comes back", async () => {
    docs = [docRow({ shareEnabled: false })];
    links = [
      linkRow({ isDefault: true, enabled: false, disabledByDocSwitch: true }),
      linkRow({ _id: OTHER_LINK, shareId: "revoked0001", label: "Benchmark", enabled: false, disabledByDocSwitch: false }),
    ];

    const res = await setAllLinksEnabled({ orgId: ORG_ID, docId: DOC_ID, enabled: true });

    expect(res.changed).toBe(1);
    expect(writes().map((w) => w.id)).toEqual([String(LINK_ID)]);
  });

  test("a row written before the marker existed has no marker, and is still restored", async () => {
    // The legacy case the old fallback was for: `disabledByDocSwitch` absent, not false.
    docs = [docRow({ shareEnabled: false })];
    const legacy = linkRow({ isDefault: true, enabled: false }) as Record<string, unknown>;
    delete legacy.disabledByDocSwitch;
    links = [legacy];

    const res = await setAllLinksEnabled({ orgId: ORG_ID, docId: DOC_ID, enabled: true });

    expect(res.changed).toBe(1);
    expect(writes().map((w) => w.id)).toEqual([String(LINK_ID)]);
  });

  test("turning the switch off marks every link it disables, so it can undo exactly that", async () => {
    docs = [docRow()];
    links = [linkRow({ isDefault: true }), linkRow({ _id: OTHER_LINK, shareId: "benchmark01", label: "Benchmark" })];

    const res = await setAllLinksEnabled({ orgId: ORG_ID, docId: DOC_ID, enabled: false });

    expect(res.changed).toBe(2);
    expect(writes().every((w) => w.set.enabled === false && w.set.disabledByDocSwitch === true)).toBe(true);
  });

  test("a document shared for the first time still turns on: its link is born marked", async () => {
    // No link row yet and `shareEnabled: false`, so `ensureDefaultLink` materialises one disabled.
    // It is off because the *document* is off, which is the switch's own doing — the alternative
    // reading (an owner revoke) would leave the Share toggle unable to do anything at all.
    docs = [docRow({ shareEnabled: false })];
    links = [];

    const res = await setAllLinksEnabled({ orgId: ORG_ID, docId: DOC_ID, enabled: true });

    expect(shareLinkCreate).toHaveBeenCalledTimes(1);
    expect(shareLinkCreate.mock.calls[0][0]).toMatchObject({ enabled: false, disabledByDocSwitch: true });
    expect(res.changed).toBe(1);
  });
});


/**
 * The Free cap counts shared **documents**, and `syncDocShareState` decides "shared" from whether
 * any link is active. That made the cap walkable: turn a document's only link off (the workspace
 * drops below the cap), upload another document (allowed), turn the first link back on — nothing
 * re-checked, and the cycle repeats without bound. The document-level switch had the check; the
 * per-link routes, which the app and the MCP both use, did not.
 *
 * What must NOT regress in fixing it: links themselves are deliberately uncapped. A second link on
 * a document that is already shared adds no document, so it must never consult the cap — one link
 * per investor is the feature.
 */
describe("the Free documents cap and the link routes", () => {
  const blocked = {
    ok: false as const,
    code: "plan_limit" as const,
    limit: "documents" as const,
    used: 3,
    max: 3,
    grace: null,
    upgradeUrl: "/pricing",
    message: "Free workspaces can share 3 documents.",
  };

  beforeEach(() => {
    (checkLimit as unknown as { mockClear: () => void }).mockClear();
    (checkLimit as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue({ ok: true, warning: null });
    (ShareLinkModel.findOneAndUpdate as unknown as { mockClear: () => void }).mockClear();
  });

  test("a new enabled link on an UNSHARED document asks the documents cap, and is born off when refused", async () => {
    docs = [docRow({ shareEnabled: false })];
    links = [linkRow({ isDefault: true, enabled: false })];
    (checkLimit as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(blocked);

    const res = await createShareLink({
      orgId: ORG_ID,
      docId: DOC_ID,
      userId: null,
      createdVia: "web",
      settings: { label: "Sequoia" },
    });

    expect(checkLimit).toHaveBeenCalledWith(ORG_ID, "documents");
    expect(res.limit.ok).toBe(false);
    expect(shareLinkCreate.mock.calls[0][0]).toMatchObject({ enabled: false });
  });

  test("a new link on an ALREADY SHARED document never consults the cap", async () => {
    docs = [docRow({ shareEnabled: true })];
    links = [linkRow({ isDefault: true, enabled: true })];

    const res = await createShareLink({
      orgId: ORG_ID,
      docId: DOC_ID,
      userId: null,
      createdVia: "web",
      settings: { label: "Accel" },
    });

    expect(checkLimit).not.toHaveBeenCalledWith(ORG_ID, "documents");
    expect(res.limit.ok).toBe(true);
    expect(shareLinkCreate.mock.calls[0][0]).toMatchObject({ enabled: true });
  });

  test("re-enabling the last link of an unshared document is refused at the cap, and writes nothing", async () => {
    docs = [docRow({ shareEnabled: false })];
    links = [linkRow({ isDefault: true, enabled: false })];
    (checkLimit as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(blocked);

    const res = await updateShareLink({ orgId: ORG_ID, linkId: LINK_ID, settings: { enabled: true } });

    expect(checkLimit).toHaveBeenCalledWith(ORG_ID, "documents");
    expect(res.limit?.ok).toBe(false);
    expect(ShareLinkModel.findOneAndUpdate).not.toHaveBeenCalled();
  });

  test("turning a link OFF is never a plan decision", async () => {
    docs = [docRow({ shareEnabled: true })];
    links = [linkRow({ isDefault: true, enabled: true })];
    (checkLimit as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(blocked);

    await updateShareLink({ orgId: ORG_ID, linkId: LINK_ID, settings: { enabled: false } });

    expect(checkLimit).not.toHaveBeenCalledWith(ORG_ID, "documents");
    expect(ShareLinkModel.findOneAndUpdate).toHaveBeenCalled();
  });

  test("the document switch keeps its own upstream check: it is not re-gated here", async () => {
    docs = [docRow({ shareEnabled: false })];
    links = [linkRow({ isDefault: true, enabled: false, disabledByDocSwitch: true })];
    (checkLimit as unknown as { mockResolvedValue: (v: unknown) => void }).mockResolvedValue(blocked);

    const res = await updateShareLink({
      orgId: ORG_ID,
      linkId: LINK_ID,
      settings: { enabled: true },
      viaDocSwitch: true,
    });

    expect(checkLimit).not.toHaveBeenCalledWith(ORG_ID, "documents");
    expect(res.limit).toBeNull();
  });
});
