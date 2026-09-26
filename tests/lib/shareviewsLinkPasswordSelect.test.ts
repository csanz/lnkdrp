/**
 * The two metrics routes read the `?shareId=` link with the password fields opted in.
 *
 * `ShareLink.password*` is `select: false` (tests/lib/sharePasswordSelect.test.ts pins the schema).
 * `GET /api/docs/:docId/shareviews?shareId=` and `GET /api/projects/:slug/shareviews?shareId=` both
 * look that one link up themselves and return it as `link: toShareLinkDTO(row)` /
 * `toProjectLinkDTO(row)`, whose `passwordEnabled` is `Boolean(row.passwordHash)`. A bare
 * `findOne` therefore answered `passwordEnabled: false` for every locked link, and the metrics page
 * (`SettingItem label="Password"` in MetricsView) rendered "Password: none" beside a link that
 * refuses everyone without the password. Not fail-open (no gate reads this row), but a wrong answer
 * on a surface the owner reads to check what they sent.
 *
 * Two assertions per route, in the style of tests/lib/sharePasswordResolverSelect.test.ts: the
 * lookup is issued with a projection naming every `+password*` field, and the row that comes back
 * reaches the response as `link.passwordEnabled: true`. Everything after the lookup (the
 * aggregates) is stubbed to empty, so the response is the shape of a link with no traffic.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG_ID = new Types.ObjectId();
const DOC_ID = new Types.ObjectId();
const PROJECT_ID = new Types.ObjectId();
const SHARE_ID = "srDP4SzZNA5a";

const { actor, linkFindOne, linkFind, chain } = vi.hoisted(() => {
  /** A mongoose-ish query: every builder returns the chain, `lean`/`exec`/`then` resolve `result`. */
  function chain<T>(result: T) {
    const c: Record<string, unknown> = {};
    for (const m of ["select", "sort", "limit", "skip", "populate", "hint", "read"]) c[m] = () => c;
    c.lean = async () => result;
    c.exec = async () => result;
    c.then = (resolve: (v: T) => unknown, reject?: (e: unknown) => unknown) => Promise.resolve(result).then(resolve, reject);
    return c;
  }
  const oid = "64b0c0ffee0000000000e001";
  return {
    chain,
    actor: { kind: "user", userId: oid, orgId: oid, personalOrgId: oid },
    linkFindOne: vi.fn(),
    linkFind: vi.fn(() => chain([])),
  };
});

/** A model that answers every read with nothing. */
function emptyModel() {
  return {
    find: vi.fn(() => chain([])),
    findOne: vi.fn(() => chain(null)),
    aggregate: vi.fn(async () => []),
    countDocuments: vi.fn(async () => 0),
    distinct: vi.fn(async () => []),
    updateOne: vi.fn(async () => ({ matchedCount: 0 })),
  };
}

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return { ...actual, after: vi.fn() };
});
vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugError: vi.fn(), debugLog: vi.fn(), debugWarn: vi.fn() }));
vi.mock("@/lib/db/mongoRequestLogger", () => ({ withMongoRequestLogging: (_r: Request, fn: () => unknown) => fn() }));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: vi.fn(async () => actor),
  tryResolveUserActorFast: vi.fn(async () => null),
  applyTempUserHeaders: (res: Response) => res,
}));
vi.mock("@/lib/billing/planLimits", () => ({
  getWorkspacePlan: vi.fn(async () => "pro"),
  clampAnalyticsDays: (_p: string, d: number) => d,
  limitsForPlan: () => ({ analyticsDays: null }),
  analyticsTierForPlan: () => "deep",
  checkLimit: vi.fn(async () => ({ ok: true, warning: null })),
}));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn() }));
vi.mock("@/lib/models/ShareLink", async () => {
  const actual = await vi.importActual<typeof import("@/lib/models/ShareLink")>("@/lib/models/ShareLink");
  return {
    DOC_LINK_FILTER: actual.DOC_LINK_FILTER,
    PROJECT_LINK_FILTER: actual.PROJECT_LINK_FILTER,
    ShareLinkModel: { findOne: linkFindOne, find: linkFind, aggregate: vi.fn(async () => []) },
  };
});
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    ...emptyModel(),
    findOne: vi.fn(() => chain({ _id: DOC_ID, orgId: ORG_ID, title: "Deck", numberOfViews: 0, numberOfPagesViewed: 0 })),
  },
}));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: emptyModel() }));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: emptyModel() }));
vi.mock("@/lib/models/ShareVisit", () => ({ ShareVisitModel: emptyModel() }));
vi.mock("@/lib/models/ProjectLinkView", () => ({ ProjectLinkViewModel: emptyModel() }));
vi.mock("@/lib/models/User", () => ({ UserModel: emptyModel() }));
vi.mock("@/app/api/projects/[projectSlug]/links/shared", () => ({
  accessProjectForLinks: vi.fn(async () => ({ ok: true, access: { actor, projectId: PROJECT_ID, orgId: ORG_ID, name: "Room" } })),
  linkErrorResponse: vi.fn((err: unknown) => {
    throw err;
  }),
}));

const { GET: docGet } = await import("@/app/api/docs/[docId]/shareviews/route");
const { GET: projectGet } = await import("@/app/api/projects/[projectSlug]/shareviews/route");
const { SHARE_LINK_PASSWORD_FIELDS } = await import("@/lib/share/passwordSelect");

/** A stored link row carrying a hash: what the opted-in read returns for a locked link. */
function lockedRow(owner: { docId: Types.ObjectId } | { projectId: Types.ObjectId }) {
  return {
    _id: new Types.ObjectId(),
    orgId: ORG_ID,
    docId: null,
    projectId: null,
    ...owner,
    shareId: SHARE_ID,
    label: "Sequoia",
    kind: "share",
    isDefault: false,
    enabled: true,
    archivedAt: null,
    expiresAt: null,
    allowDownload: true,
    passwordHash: "qN0tArEaLhAsH",
    passwordSalt: "saltysalt",
    createdAt: new Date("2026-09-01T00:00:00Z"),
    updatedAt: new Date("2026-09-01T00:00:00Z"),
  };
}

/** The lookup's projection argument, as the list of `+fields` it opts in to. */
function optedIn(call: unknown[]): string[] {
  const projection = call[1];
  if (typeof projection === "string") return projection.split(/\s+/).filter(Boolean);
  if (projection && typeof projection === "object") return Object.keys(projection);
  return [];
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/docs/:docId/shareviews?shareId=", () => {
  test("reads the link with every password field opted in, and reports it as password-protected", async () => {
    linkFindOne.mockReturnValue(chain(lockedRow({ docId: DOC_ID })));

    const res = await docGet(new Request(`http://localhost/api/docs/${DOC_ID}/shareviews?shareId=${SHARE_ID}&days=15`), {
      params: Promise.resolve({ docId: DOC_ID.toString() }),
    });
    const body = (await res.json()) as { perLink?: boolean; link?: { shareId: string; passwordEnabled: boolean } };

    expect(res.status).toBe(200);
    // The first ShareLink read is the `?shareId=` lookup, keyed on the slug and the document.
    const [filter] = linkFindOne.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(filter).toMatchObject({ shareId: SHARE_ID, docId: DOC_ID, archivedAt: null });
    const fields = optedIn(linkFindOne.mock.calls[0] as unknown[]);
    for (const f of SHARE_LINK_PASSWORD_FIELDS) expect(fields).toContain(`+${f}`);

    expect(body.link?.shareId).toBe(SHARE_ID);
    expect(body.link?.passwordEnabled).toBe(true);
  });
});

describe("GET /api/projects/:slug/shareviews?shareId=", () => {
  test("reads the link with every password field opted in, and reports it as password-protected", async () => {
    linkFindOne.mockReturnValue(chain(lockedRow({ projectId: PROJECT_ID })));

    const res = await projectGet(new Request(`http://localhost/api/projects/${PROJECT_ID}/shareviews?shareId=${SHARE_ID}&days=15`), {
      params: Promise.resolve({ projectSlug: PROJECT_ID.toString() }),
    });
    const body = (await res.json()) as { link?: { shareId: string; passwordEnabled: boolean } };

    expect(res.status).toBe(200);
    const [filter] = linkFindOne.mock.calls[0] as [Record<string, unknown>, unknown];
    expect(filter).toMatchObject({ shareId: SHARE_ID, projectId: PROJECT_ID });
    const fields = optedIn(linkFindOne.mock.calls[0] as unknown[]);
    for (const f of SHARE_LINK_PASSWORD_FIELDS) expect(fields).toContain(`+${f}`);

    expect(body.link?.shareId).toBe(SHARE_ID);
    expect(body.link?.passwordEnabled).toBe(true);
  });
});
