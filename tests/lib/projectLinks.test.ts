/**
 * Project share links service — the default-link fallback, the refusal matrix `/p/:shareId` will
 * depend on, the Pro gate, and the promise that document-scoped reads can never see a project link
 * (docs/prds/lnkdrp-project-links.md, milestone M1).
 *
 * The models are mocked in the same style as tests/lib/shareLinks.test.ts: `ShareLinkModel` and
 * `ProjectModel` answer from in-memory arrays, so a test only has to say which rows exist. The
 * matchers below reproduce the exact filters the service issues — including the `kind` clause,
 * which is the whole point of the exercise.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const connectMongo = vi.fn(async () => undefined);

/** In-memory rows the mocked models answer from. */
let links: Record<string, unknown>[] = [];
let projects: Record<string, unknown>[] = [];
let docs: Record<string, unknown>[] = [];

const projectUpdateOne = vi.fn(async () => ({ acknowledged: true }));
const shareLinkCreate = vi.fn(async (payload: Record<string, unknown>) => {
  const row = { _id: new Types.ObjectId(), createdDate: new Date(), viewCount: 0, downloadCount: 0, ...payload };
  links.push(row);
  return { toObject: () => row };
});

/** True when one stored link satisfies one filter clause (the subset of operators the service uses). */
function linkMatches(l: Record<string, any>, f: Record<string, any>): boolean {
  if (f.shareId !== undefined && l.shareId !== f.shareId) return false;
  if (f._id !== undefined && String(l._id) !== String(f._id)) return false;
  if (f.docId !== undefined && String(l.docId ?? null) !== String(f.docId ?? null)) return false;
  if (f.projectId !== undefined && String(l.projectId ?? null) !== String(f.projectId ?? null)) return false;
  if (f.orgId !== undefined && String(l.orgId) !== String(f.orgId)) return false;
  if (f.isDefault !== undefined && Boolean(l.isDefault) !== f.isDefault) return false;
  if (f.archivedAt === null && l.archivedAt) return false;
  // `kind` arrives either as `"project"` or as `{ $ne: "project" }` — a stored row written before
  // project links existed has no `kind` at all, and must satisfy the second form.
  if (typeof f.kind === "string" && l.kind !== f.kind) return false;
  if (f.kind && typeof f.kind === "object" && "$ne" in f.kind && l.kind === f.kind.$ne) return false;
  return true;
}

/** The single-row lookups the service issues (`findOne`), including its `$or` fallbacks. */
function matchLink(filter: Record<string, any>): Record<string, unknown> | null {
  const candidates = Array.isArray(filter.$or) ? filter.$or : [filter];
  for (const f of candidates) {
    const hit = links.find((l) => linkMatches(l, f));
    if (hit) return hit;
  }
  return null;
}

/** The multi-row lookups (`find`, `countDocuments`). */
function matchLinks(filter: Record<string, any>): Record<string, unknown>[] {
  return links.filter((l) => linkMatches(l, filter));
}

/** The filters the service issues against `projects` (by `_id`, by `shareId`, org-scoped). */
function matchProject(filter: Record<string, any>): Record<string, unknown> | null {
  return (
    projects.find((p) => {
      if (filter._id !== undefined && String(p._id) !== String(filter._id)) return false;
      if (filter.shareId !== undefined && p.shareId !== filter.shareId) return false;
      if (filter.orgId !== undefined && String(p.orgId) !== String(filter.orgId)) return false;
      if (filter.isDeleted && p.isDeleted) return false;
      return true;
    }) ?? null
  );
}

vi.mock("@/lib/mongodb", () => ({ connectMongo }));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    findOne: vi.fn((filter: Record<string, unknown>) => ({
      select: () => ({ lean: async () => matchProject(filter) }),
      lean: async () => matchProject(filter),
    })),
    updateOne: projectUpdateOne,
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: vi.fn((filter: Record<string, any>) => ({
      select: () => ({ lean: async () => docs.find((d) => String(d._id) === String(filter._id) || d.shareId === filter.shareId) ?? null }),
      lean: async () => docs.find((d) => String(d._id) === String(filter._id) || d.shareId === filter.shareId) ?? null,
    })),
    updateOne: vi.fn(async () => ({ acknowledged: true })),
  },
}));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { aggregate: vi.fn(async () => []) } }));
vi.mock("@/lib/models/ShareLink", async () => {
  const actual = await vi.importActual<typeof import("@/lib/models/ShareLink")>("@/lib/models/ShareLink");
  return {
    DOC_LINK_FILTER: actual.DOC_LINK_FILTER,
    PROJECT_LINK_FILTER: actual.PROJECT_LINK_FILTER,
    ShareLinkModel: {
      findOne: vi.fn((filter: Record<string, unknown>) => ({ lean: async () => matchLink(filter) })),
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
      findOneAndUpdate: vi.fn((filter: Record<string, any>, update: Record<string, any>) => ({
        lean: async () => {
          const row = matchLink(filter);
          if (row) Object.assign(row, update.$set ?? {});
          return row;
        },
      })),
      updateOne: vi.fn(async () => ({ acknowledged: true })),
      updateMany: vi.fn(async () => ({ acknowledged: true })),
    },
  };
});
vi.mock("@/lib/crypto/randomBase62", () => ({ newShareId: () => "generatedSlug1" }));

/** A project that predates workspaces is adopted into its owner's personal org before a link is made. */
const PERSONAL_ORG_ID = new Types.ObjectId();
const ensurePersonalOrgForUserId = vi.fn(async () => ({ orgId: PERSONAL_ORG_ID }));
vi.mock("@/lib/models/Org", () => ({
  ensurePersonalOrgForUserId: (...args: unknown[]) => ensurePersonalOrgForUserId(...(args as [])),
}));

const checkLimit = vi.fn(async () => ({ ok: true, warning: null }) as unknown);
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit: (...args: unknown[]) => checkLimit(...(args as [])) }));

const {
  archiveProjectLink,
  createProjectLink,
  ensureDefaultProjectLink,
  listProjectLinks,
  resolveProjectLink,
  toProjectLinkDTO,
  updateProjectLink,
} = await import("@/lib/share/projectLinks");
const { listShareLinks, resolveShareLink } = await import("@/lib/share/links");

const ORG_ID = new Types.ObjectId();
const PROJECT_ID = new Types.ObjectId();
const DOC_ID = new Types.ObjectId();
const LINK_ID = new Types.ObjectId();

/** A stored project-link row, active unless overridden. */
function projectLinkRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: LINK_ID,
    orgId: ORG_ID,
    projectId: PROJECT_ID,
    docId: null,
    kind: "project",
    shareId: "prDP4SzZNA5a",
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

/** A stored Project row, live and shared unless overridden. */
function projectRow(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROJECT_ID,
    orgId: ORG_ID,
    userId: new Types.ObjectId(),
    name: "Series A data room",
    shareId: "prDP4SzZNA5a",
    shareEnabled: true,
    isDeleted: false,
    ...overrides,
  };
}

/** The Free answer from `checkLimit("project_links")`: a feature gate, so no counting and no grace. */
const FREE_BLOCKED = {
  ok: false,
  code: "plan_limit",
  limit: "project_links",
  used: 0,
  max: 0,
  grace: null,
  upgradeUrl: "/pricing",
  message: "Sending a project to more than one audience is a Pro feature.",
};

beforeEach(() => {
  links = [];
  projects = [];
  docs = [];
  projectUpdateOne.mockClear();
  shareLinkCreate.mockClear();
  checkLimit.mockClear();
  checkLimit.mockResolvedValue({ ok: true, warning: null });
});

describe("toProjectLinkDTO", () => {
  test("an active link reports its settings and no document", () => {
    const dto = toProjectLinkDTO(projectLinkRow() as never);
    expect(dto).toMatchObject({ projectId: String(PROJECT_ID), shareId: "prDP4SzZNA5a", status: "active", active: true, passwordEnabled: false });
    expect(dto).not.toHaveProperty("docId");
  });

  test("archived beats disabled beats expired", () => {
    const past = new Date(Date.now() - 1000);
    expect(toProjectLinkDTO(projectLinkRow({ archivedAt: new Date(), enabled: false, expiresAt: past }) as never).status).toBe("archived");
    expect(toProjectLinkDTO(projectLinkRow({ enabled: false, expiresAt: past }) as never).status).toBe("disabled");
    expect(toProjectLinkDTO(projectLinkRow({ expiresAt: past }) as never).status).toBe("expired");
  });

  test("a password on the link shows as passwordEnabled without leaking the material", () => {
    const dto = toProjectLinkDTO(projectLinkRow({ passwordHash: "hash", passwordSalt: "salt" }) as never);
    expect(dto.passwordEnabled).toBe(true);
    expect(JSON.stringify(dto)).not.toContain("hash");
  });
});

/**
 * `ensureDefaultProjectLink` answers `null` for a project it cannot place in a workspace, so every
 * case that expects a link says so once here instead of asserting non-null in each test.
 */
async function ensureDefault(
  project: unknown,
  opts?: Parameters<typeof ensureDefaultProjectLink>[1],
): Promise<NonNullable<Awaited<ReturnType<typeof ensureDefaultProjectLink>>>> {
  const link = await ensureDefaultProjectLink(project as never, opts);
  if (!link) throw new Error("expected a default link");
  return link;
}

describe("ensureDefaultProjectLink", () => {
  test("adopts Project.shareId so an existing /p/:shareId keeps resolving", async () => {
    const link = await ensureDefault(projectRow());
    expect(link.shareId).toBe("prDP4SzZNA5a");
    expect(link.isDefault).toBe(true);
    expect(link.kind).toBe("project");
    expect(link.docId ?? null).toBeNull();
    // It adopted the project's slug, so the project needs no rewrite.
    expect(projectUpdateOne).not.toHaveBeenCalled();
  });

  test("a project switched off materialises a disabled default link", async () => {
    const link = await ensureDefault(projectRow({ shareEnabled: false }));
    expect(link.enabled).toBe(false);
  });

  test("is idempotent", async () => {
    await ensureDefault(projectRow());
    await ensureDefault(projectRow());
    expect(shareLinkCreate).toHaveBeenCalledTimes(1);
  });

  test("a slug already taken by a document link is not adopted", async () => {
    // `Doc.shareId` and `Project.shareId` are unique only within their own collections, so the two
    // can collide. Adopting the document's row would point /p/ at a document.
    links.push({ _id: new Types.ObjectId(), shareId: "prDP4SzZNA5a", docId: DOC_ID, kind: "doc", projectId: null });
    const link = await ensureDefault(projectRow());
    expect(link.shareId).toBe("generatedSlug1");
    expect(projectUpdateOne).toHaveBeenCalled();
  });

  test("a project with no shareId gets one, and the project is pointed at it", async () => {
    const link = await ensureDefault(projectRow({ shareId: null }));
    expect(link.shareId).toBe("generatedSlug1");
    expect(projectUpdateOne).toHaveBeenCalled();
  });

  test("a legacy project with no orgId is adopted into its owner's personal workspace", async () => {
    // `ShareLink.orgId` is `required: true`, so passing the missing id straight through made this a
    // ValidationError — and the throw reached a recipient on `/p/:shareId` as a 500.
    const link = await ensureDefault(projectRow({ orgId: null }));
    expect(ensurePersonalOrgForUserId).toHaveBeenCalled();
    expect(String(link.orgId)).toBe(String(PERSONAL_ORG_ID));
    // The id is written back, so the adoption happens once and the owner-side routes see it too.
    expect(projectUpdateOne).toHaveBeenCalled();
  });

  test("a legacy project with neither workspace nor owner yields no link instead of throwing", async () => {
    const link = await ensureDefaultProjectLink(projectRow({ orgId: null, userId: null }) as never);
    expect(link).toBeNull();
    expect(shareLinkCreate).not.toHaveBeenCalled();
  });
});

describe("resolveProjectLink", () => {
  test("an active link resolves with no refusal", async () => {
    projects.push(projectRow());
    links.push(projectLinkRow({ isDefault: true }));
    const resolved = await resolveProjectLink("prDP4SzZNA5a");
    expect(resolved?.refusal).toBeNull();
    expect(resolved?.project.name).toBe("Series A data room");
  });

  test("disabled, expired and archived each refuse with their own reason", async () => {
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ enabled: false }, "disabled"],
      [{ expiresAt: new Date(Date.now() - 1000) }, "expired"],
      [{ archivedAt: new Date() }, "archived"],
    ];
    for (const [overrides, expected] of cases) {
      projects = [projectRow()];
      links = [projectLinkRow(overrides)];
      expect((await resolveProjectLink("prDP4SzZNA5a"))?.refusal).toBe(expected);
    }
  });

  test("a future expiry still resolves", async () => {
    projects.push(projectRow());
    links.push(projectLinkRow({ expiresAt: new Date(Date.now() + 86_400_000) }));
    expect((await resolveProjectLink("prDP4SzZNA5a"))?.refusal).toBeNull();
  });

  test("a deleted project is project_gone", async () => {
    projects.push(projectRow({ isDeleted: true }));
    links.push(projectLinkRow());
    expect((await resolveProjectLink("prDP4SzZNA5a"))?.refusal).toBe("project_gone");
  });

  test("falls back to Project.shareId and materialises the default link", async () => {
    projects.push(projectRow());
    const resolved = await resolveProjectLink("prDP4SzZNA5a");
    expect(resolved?.refusal).toBeNull();
    expect(resolved?.link.isDefault).toBe(true);
    expect(shareLinkCreate).toHaveBeenCalledTimes(1);
  });

  test("a document link's slug is not a project slug", async () => {
    // The two trees share one slug namespace; each refuses the other's slugs rather than
    // redirecting, which would tell a stranger that some other share exists.
    links.push({ _id: new Types.ObjectId(), shareId: "srDocSlug", docId: DOC_ID, kind: "doc", projectId: null });
    expect(await resolveProjectLink("srDocSlug")).toBeNull();
  });

  test("an unknown slug and an empty slug are both null", async () => {
    expect(await resolveProjectLink("nope")).toBeNull();
    expect(await resolveProjectLink("")).toBeNull();
  });
});

describe("createProjectLink", () => {
  test("Pro creates a second link with its own settings", async () => {
    projects.push(projectRow());
    const { link, limit } = await createProjectLink({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      userId: null,
      createdVia: "api",
      settings: { label: "a16z", audience: "Martin", allowDownload: true, password: "hunter2" },
    });
    expect(limit.ok).toBe(true);
    expect(link).toBeTruthy();
    expect(link?.isDefault).toBe(false);
    expect(link?.kind).toBe("project");
    expect(link?.allowDownload).toBe(true);
    expect(link?.passwordHash).toBeTruthy();
    // Never on a project link: there is no single document whose versions it could list.
    expect(link?.allowRevisionHistory).toBe(false);
  });

  test("Free is refused, and nothing is written", async () => {
    projects.push(projectRow());
    checkLimit.mockResolvedValue(FREE_BLOCKED);
    const { link, limit } = await createProjectLink({
      orgId: ORG_ID,
      projectId: PROJECT_ID,
      userId: null,
      createdVia: "web",
      settings: { label: "a16z" },
    });
    expect(link).toBeNull();
    expect(limit).toMatchObject({ ok: false, code: "plan_limit", limit: "project_links" });
    // The default link was still materialised (it already exists in the world); the second was not.
    expect(links.filter((l) => !l.isDefault)).toHaveLength(0);
  });

  test("Free still gets a validation error for a blank label, not an upsell", async () => {
    projects.push(projectRow());
    checkLimit.mockResolvedValue(FREE_BLOCKED);
    await expect(
      createProjectLink({ orgId: ORG_ID, projectId: PROJECT_ID, userId: null, createdVia: "web", settings: { label: "  " } }),
    ).rejects.toThrow(/label is required/i);
  });

  test("an expiry in the past is refused", async () => {
    projects.push(projectRow());
    await expect(
      createProjectLink({ orgId: ORG_ID, projectId: PROJECT_ID, userId: null, createdVia: "web", settings: { label: "a16z", expiresAt: "2020-01-01" } }),
    ).rejects.toThrow(/must be in the future/i);
  });

  test("a project in another workspace is not found", async () => {
    projects.push(projectRow({ orgId: new Types.ObjectId() }));
    await expect(
      createProjectLink({ orgId: ORG_ID, projectId: PROJECT_ID, userId: null, createdVia: "web", settings: { label: "a16z" } }),
    ).rejects.toThrow(/Project not found/i);
  });
});

describe("updateProjectLink and archiveProjectLink", () => {
  test("disabling a link leaves it resolvable-but-refused, not deleted", async () => {
    projects.push(projectRow());
    links.push(projectLinkRow());
    const { link } = await updateProjectLink({ orgId: ORG_ID, linkId: LINK_ID, settings: { enabled: false } });
    expect(link.enabled).toBe(false);
    expect(link.archivedAt ?? null).toBeNull();
  });

  test("a document link's id cannot be patched through the project service", async () => {
    links.push({ ...projectLinkRow(), kind: "doc", docId: DOC_ID, projectId: null });
    await expect(updateProjectLink({ orgId: ORG_ID, linkId: LINK_ID, settings: { label: "x" } })).rejects.toThrow(/Link not found/i);
  });

  test("the default link refuses to be archived", async () => {
    projects.push(projectRow());
    links.push(projectLinkRow({ isDefault: true }));
    await expect(archiveProjectLink({ orgId: ORG_ID, linkId: LINK_ID })).rejects.toThrow(/cannot be deleted/i);
  });

  test("a non-default link archives and is dropped from the list", async () => {
    projects.push(projectRow());
    links.push(projectLinkRow({ _id: new Types.ObjectId(), isDefault: true, shareId: "prDefault1" }));
    links.push(projectLinkRow());
    await archiveProjectLink({ orgId: ORG_ID, linkId: LINK_ID });
    const rows = await listProjectLinks({ orgId: ORG_ID, projectId: PROJECT_ID });
    expect(rows.map((l) => l.shareId)).toEqual(["prDefault1"]);
  });
});

describe("the two kinds never leak into each other's lists", () => {
  test("listProjectLinks returns only project links, default first", async () => {
    projects.push(projectRow());
    links.push({ _id: new Types.ObjectId(), orgId: ORG_ID, docId: DOC_ID, projectId: null, kind: "doc", shareId: "srDoc1", label: "Doc link", archivedAt: null });
    links.push(projectLinkRow({ createdDate: new Date("2026-09-02T10:00:00.000Z") }));
    links.push(projectLinkRow({ _id: new Types.ObjectId(), shareId: "prDefault1", isDefault: true, createdDate: new Date("2026-08-01T10:00:00.000Z") }));
    const rows = await listProjectLinks({ orgId: ORG_ID, projectId: PROJECT_ID });
    expect(rows.map((l) => l.shareId)).toEqual(["prDefault1", "prDP4SzZNA5a"]);
  });

  test("listShareLinks on a document never returns the project's links", async () => {
    docs.push({ _id: DOC_ID, orgId: ORG_ID, shareId: "srDoc1", shareEnabled: true, isDeleted: false });
    links.push({ _id: new Types.ObjectId(), orgId: ORG_ID, docId: DOC_ID, projectId: null, kind: "doc", shareId: "srDoc1", isDefault: true, archivedAt: null });
    links.push(projectLinkRow());
    const rows = await listShareLinks({ orgId: ORG_ID, docId: DOC_ID });
    expect(rows.map((l) => l.shareId)).toEqual(["srDoc1"]);
  });

  test("resolveShareLink refuses a project slug rather than reporting a missing document", async () => {
    // Left unguarded this returned `refusal: "doc_gone"`, which reads in logs and in the
    // download-token paths as "the document was deleted" instead of "wrong tree".
    projects.push(projectRow());
    links.push(projectLinkRow());
    expect(await resolveShareLink("prDP4SzZNA5a")).toBeNull();
  });
});
