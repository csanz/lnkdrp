/**
 * The public side of project links: the analytics key a project-link visit is written under, the
 * document the stats ingest recovers from the page that sent it, and the membership rule that
 * decides what `/p/:shareId/:docId` is allowed to serve
 * (docs/prds/lnkdrp-project-links.md, milestone M2).
 *
 * `DocModel` and `resolveProjectLink` are mocked in the same style as `projectLinks.test.ts`: the
 * doc lookup answers from an in-memory array and records the filter it was handed, so a test can
 * assert on the *filter* — which is where the security lives — rather than on a result that a
 * different filter could also have produced.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

/** Filters `DocModel.find` / `.findOne` were called with, newest last. */
let docFilters: Record<string, any>[] = [];
let docs: Record<string, any>[] = [];

/** True when a stored doc satisfies the public membership filter the module builds. */
function docMatches(d: Record<string, any>, f: Record<string, any>): boolean {
  if (f._id && String(d._id) !== String(f._id)) return false;
  if (f.orgId && String(d.orgId) !== String(f.orgId)) return false;
  if (f.isDeleted && d.isDeleted === true) return false;
  if (f.isArchived && d.isArchived === true) return false;
  if (f.shareEnabled && d.shareEnabled === false) return false;
  if (Array.isArray(f.$or)) {
    const ok = f.$or.some((clause: Record<string, any>) => {
      if (clause.projectId) return String(d.projectId ?? "") === String(clause.projectId);
      if (clause.projectIds) return (d.projectIds ?? []).some((p: unknown) => String(p) === String(clause.projectIds));
      return false;
    });
    if (!ok) return false;
  }
  return true;
}

function chain(rows: Record<string, any>[]) {
  const self = {
    select: () => self,
    sort: () => self,
    lean: async () => rows,
  };
  return self;
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));

vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    find: (filter: Record<string, any>) => {
      docFilters.push(filter);
      return chain(docs.filter((d) => docMatches(d, filter)));
    },
    findOne: (filter: Record<string, any>) => {
      docFilters.push(filter);
      const hit = docs.find((d) => docMatches(d, filter)) ?? null;
      return { select: () => ({ lean: async () => hit }) };
    },
  },
}));

/** Only `isExpired` is used from the document service, and only through the re-export. */
vi.mock("@/lib/share/links", () => ({ isExpired: (l: { expiresAt?: Date | null }) => Boolean(l.expiresAt && l.expiresAt.getTime() < Date.now()) }));

const resolveProjectLink = vi.fn();
vi.mock("@/lib/share/projectLinks", () => ({ resolveProjectLink: (...a: unknown[]) => resolveProjectLink(...a) }));

const {
  PROJECT_VIEW_KEY_SEP,
  projectViewerKey,
  splitProjectViewerKey,
  projectDocIdFromReferer,
  resolveProjectStatsTarget,
  findProjectDocument,
  listProjectDocuments,
  resolveProjectDocument,
  projectLinkPasswordEnabled,
} = await import("@/lib/share/projectPublic");

const PROJECT_ID = new Types.ObjectId();
const ORG_ID = new Types.ObjectId();
const DOC_A = new Types.ObjectId();
const DOC_B = new Types.ObjectId();
const OUTSIDER = new Types.ObjectId();

const project = { _id: PROJECT_ID, orgId: ORG_ID, name: "Data room", shareId: "PROJSLUG", isDeleted: false };

beforeEach(() => {
  docFilters = [];
  docs = [
    { _id: DOC_A, orgId: ORG_ID, projectId: PROJECT_ID, title: "Deck" },
    { _id: DOC_B, orgId: ORG_ID, projectIds: [PROJECT_ID], title: "Term sheet" },
    { _id: OUTSIDER, orgId: ORG_ID, projectId: new Types.ObjectId(), title: "Somebody else's" },
  ];
  resolveProjectLink.mockReset();
});

describe("projectViewerKey", () => {
  test("carries the document inside the key the unique index already has", () => {
    const key = projectViewerKey("a".repeat(64), DOC_A);
    expect(key).toBe(`${"a".repeat(64)}${PROJECT_VIEW_KEY_SEP}${String(DOC_A)}`);
    // Two documents behind one project link must not collide on `{shareId, botIdHash}` — the whole
    // reason the composite exists.
    expect(projectViewerKey("a".repeat(64), DOC_B)).not.toBe(key);
  });

  test("round-trips back to the person, so a project link's viewers stay countable", () => {
    const botIdHash = "b".repeat(64);
    expect(splitProjectViewerKey(projectViewerKey(botIdHash, DOC_A))).toEqual({ botIdHash, docId: String(DOC_A) });
  });

  test("a document link's bare digest is left alone and reports no document", () => {
    const bare = "c".repeat(64);
    expect(splitProjectViewerKey(bare)).toEqual({ botIdHash: bare, docId: null });
  });
});

describe("projectDocIdFromReferer", () => {
  test("recovers the document from the page that posted", () => {
    expect(projectDocIdFromReferer(`https://lnkdrp.com/p/SLUG/${String(DOC_A)}`, "SLUG")).toBe(String(DOC_A));
  });

  test("ignores a referer from a different link", () => {
    // Otherwise a recipient of link B could attribute their reading to link A.
    expect(projectDocIdFromReferer(`https://lnkdrp.com/p/OTHER/${String(DOC_A)}`, "SLUG")).toBeNull();
  });

  test("ignores anything that is not a /p/:shareId/:docId page", () => {
    expect(projectDocIdFromReferer("https://lnkdrp.com/s/SLUG", "SLUG")).toBeNull();
    expect(projectDocIdFromReferer("https://lnkdrp.com/p/SLUG", "SLUG")).toBeNull();
    expect(projectDocIdFromReferer("https://lnkdrp.com/p/SLUG/not-an-object-id", "SLUG")).toBeNull();
    expect(projectDocIdFromReferer("not a url", "SLUG")).toBeNull();
    expect(projectDocIdFromReferer(null, "SLUG")).toBeNull();
  });

  test("survives a percent-encoded slug", () => {
    expect(projectDocIdFromReferer(`https://lnkdrp.com/p/${encodeURIComponent("a b")}/${String(DOC_A)}`, "a b")).toBe(String(DOC_A));
  });
});

describe("findProjectDocument", () => {
  test("finds a document by projectId and by projectIds", async () => {
    expect(String((await findProjectDocument(project as never, DOC_A))!._id)).toBe(String(DOC_A));
    expect(String((await findProjectDocument(project as never, DOC_B))!._id)).toBe(String(DOC_B));
  });

  test("refuses a document that is not in the project", async () => {
    expect(await findProjectDocument(project as never, OUTSIDER)).toBeNull();
  });

  test("refuses a malformed id without throwing a cast error", async () => {
    // This id comes straight out of a public URL; a 500 would be a fingerprinting oracle.
    expect(await findProjectDocument(project as never, "../../etc/passwd")).toBeNull();
    expect(docFilters).toHaveLength(0);
  });

  test("applies the deleted / archived / share-switch guards", async () => {
    await findProjectDocument(project as never, DOC_A);
    const f = docFilters.at(-1)!;
    expect(f.isDeleted).toEqual({ $ne: true });
    expect(f.isArchived).toEqual({ $ne: true });
    expect(f.shareEnabled).toEqual({ $ne: false });
    expect(f.orgId).toBe(ORG_ID);
  });

  test("an archived or un-shared document is invisible through the project link", async () => {
    docs[0].isArchived = true;
    expect(await findProjectDocument(project as never, DOC_A)).toBeNull();
    docs[0].isArchived = false;
    docs[0].shareEnabled = false;
    expect(await findProjectDocument(project as never, DOC_A)).toBeNull();
  });

  test("the list and the lookup apply the same filter, so they cannot disagree", async () => {
    docFilters = [];
    await listProjectDocuments(project as never);
    const listFilter = { ...docFilters.at(-1)! };
    docFilters = [];
    await findProjectDocument(project as never, DOC_A);
    const oneFilter = { ...docFilters.at(-1)! };
    delete oneFilter._id;
    expect(oneFilter).toEqual(listFilter);
  });
});

describe("resolveProjectDocument", () => {
  test("returns the link and the document for a live member", async () => {
    resolveProjectLink.mockResolvedValue({ link: { shareId: "SLUG" }, project, refusal: null });
    const r = await resolveProjectDocument("SLUG", String(DOC_A));
    expect(String(r!.doc._id)).toBe(String(DOC_A));
    expect(r!.refusal).toBeNull();
  });

  test("returns null for a document that is not in the project", async () => {
    // Null rather than a refusal on purpose: the shape of the answer must not tell a recipient that
    // a document id exists elsewhere in the workspace.
    resolveProjectLink.mockResolvedValue({ link: { shareId: "SLUG" }, project, refusal: null });
    expect(await resolveProjectDocument("SLUG", String(OUTSIDER))).toBeNull();
  });

  test("returns null when the slug is not a project link's", async () => {
    resolveProjectLink.mockResolvedValue(null);
    expect(await resolveProjectDocument("A-DOC-SLUG", String(DOC_A))).toBeNull();
  });

  test("carries a refusal through so the caller renders it, document or not", async () => {
    resolveProjectLink.mockResolvedValue({ link: { shareId: "SLUG" }, project, refusal: "expired" });
    const r = await resolveProjectDocument("SLUG", String(DOC_A));
    expect(r!.refusal).toBe("expired");
  });
});

describe("resolveProjectStatsTarget", () => {
  const req = (referer?: string) => new Request("https://lnkdrp.com/api/share/SLUG/stats", { headers: referer ? { referer } : {} });

  test("prefers an explicit docId in the body", async () => {
    resolveProjectLink.mockResolvedValue({ link: { shareId: "SLUG" }, project, refusal: null });
    const r = await resolveProjectStatsTarget({ shareId: "SLUG", request: req(), bodyDocId: String(DOC_B) });
    expect(String(r!.doc._id)).toBe(String(DOC_B));
  });

  test("falls back to the page that posted", async () => {
    resolveProjectLink.mockResolvedValue({ link: { shareId: "SLUG" }, project, refusal: null });
    const r = await resolveProjectStatsTarget({ shareId: "SLUG", request: req(`https://lnkdrp.com/p/SLUG/${String(DOC_A)}`) });
    expect(String(r!.doc._id)).toBe(String(DOC_A));
  });

  test("a claimed document outside the project is still refused", async () => {
    // The body and the referer are both the recipient's; membership is ours.
    resolveProjectLink.mockResolvedValue({ link: { shareId: "SLUG" }, project, refusal: null });
    expect(await resolveProjectStatsTarget({ shareId: "SLUG", request: req(), bodyDocId: String(OUTSIDER) })).toBeNull();
  });

  test("names no document, records nothing", async () => {
    expect(await resolveProjectStatsTarget({ shareId: "SLUG", request: req() })).toBeNull();
    expect(resolveProjectLink).not.toHaveBeenCalled();
  });
});

describe("projectLinkPasswordEnabled", () => {
  test("needs both halves of the password material", () => {
    expect(projectLinkPasswordEnabled({ passwordHash: "h", passwordSalt: "s" })).toBe(true);
    expect(projectLinkPasswordEnabled({ passwordHash: "h", passwordSalt: null })).toBe(false);
    expect(projectLinkPasswordEnabled({ passwordHash: null, passwordSalt: "s" })).toBe(false);
    expect(projectLinkPasswordEnabled({})).toBe(false);
  });
});
