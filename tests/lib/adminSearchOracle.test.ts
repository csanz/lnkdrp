/**
 * The admin list routes stopped *returning* the share slug and the request upload token, and then
 * kept handing them back through the search box, one character at a time.
 *
 * Every one of the four listings built an unanchored, case-insensitive `new RegExp(q)` and matched
 * it against `{ shareId: rx }` (and, on projects/requests, `{ requestUploadToken: rx }`) while still
 * returning per-row identity and a `total`. A substring filter over a field the caller cannot read
 * is an extraction oracle: pick a target row with a two-character `q`, extend the substring by one
 * character and keep whichever of the 62 candidates leaves that row in the response. Both tokens are
 * base62 (`newShareId()` is 12 characters, `newRequestUploadToken()` 24), so the whole value falls
 * out in ~12 x 62 and ~24 x 62 requests — nothing rate-limits these routes. What the caller gets at
 * the end is `/s/<shareId>`, which renders the customer's document, and a token that
 * `POST /api/requests/:token/uploads` turns into a fresh `uploadSecret`: a session-less, unexpiring
 * write into someone else's repo. Redaction moved the tokens out of the projection; the filter put
 * them back.
 *
 * So the tests below are about the *filter*, not the payload. Each route is driven with a real
 * request, the filter it hands Mongo is captured, and that filter is evaluated against rows by a
 * small matcher — the same question the oracle asks ("did my probe keep this row?"), answered
 * without a database. A prefix of a token must not select its row; the whole token must. The
 * substring search over staff-authored text (label, audience, title, name, slug) has to keep
 * working, because those columns come back in every row and searching them gives nothing away.
 *
 * The routes spell the whole-value match `{ shareId: { $eq: q } }`. The operator is not decoration:
 * `tests/lib/adminRouteSecrets.test.ts` scans these four sources for `shareId: <something>` and only
 * tolerates a filter or a projection, so the shape has to say "match" out loud.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const shareLinkFind = vi.fn();
const shareLinkCount = vi.fn();
const docFind = vi.fn();
const docCount = vi.fn();
const orgFind = vi.fn();
const projectFind = vi.fn();
const projectCount = vi.fn();
const projectUpdateMany = vi.fn();

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/gating/requireAdmin", () => ({
  requireAdmin: vi.fn(async () => ({ ok: true, userId: "staff", email: "staff@lnkdrp.test" })),
}));
vi.mock("@/lib/models/ShareLink", () => ({
  ShareLinkModel: { find: shareLinkFind, countDocuments: shareLinkCount },
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: { find: docFind, countDocuments: docCount } }));
vi.mock("@/lib/models/Org", () => ({ OrgModel: { find: orgFind } }));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: { find: projectFind, countDocuments: projectCount, updateMany: projectUpdateMany },
}));

const { GET: listLinks } = await import("@/app/api/admin/data/links/route");
const { GET: listDocs } = await import("@/app/api/admin/data/docs/route");
const { GET: listProjects } = await import("@/app/api/admin/data/projects/route");
const { GET: listRequests } = await import("@/app/api/admin/data/requests/route");

/** A real 12-character base62 slug and a 24-character upload token, shaped like the minted ones. */
const SHARE_ID = "Ab3Kd9Zq1XcV";
const UPLOAD_TOKEN = "Qm7tPzR2wL4nB9hJ6vY0sKdE";

/** A Mongoose query stub: every builder call returns itself, `lean()` returns the rows. */
function query(result: unknown) {
  const q: Record<string, unknown> = {};
  for (const method of ["sort", "skip", "limit", "select", "populate"]) q[method] = () => q;
  q.lean = async () => result;
  return q;
}

function req(qs: string): Request {
  return new Request(`https://lnkdrp.com/api/admin/data?${qs}`, { headers: { host: "lnkdrp.com" } });
}

/**
 * Evaluate a Mongo filter against one row — enough of the query language for these four routes.
 *
 * The depth cap is not decoration: the requests route used to push its own filter into its `$and`
 * and then delete the key it had just captured, leaving `$and[0]` pointing at the filter itself. A
 * cyclic filter is not a filter, so this throws rather than looping.
 */
function matches(filter: unknown, row: Record<string, unknown>, depth = 0): boolean {
  if (depth > 20) throw new Error("filter nests deeper than 20 levels — cyclic or self-referential");
  if (!filter || typeof filter !== "object") return true;
  return Object.entries(filter as Record<string, unknown>).every(([key, cond]) => {
    if (key === "$and") return (cond as unknown[]).every((c) => matches(c, row, depth + 1));
    if (key === "$or") return (cond as unknown[]).some((c) => matches(c, row, depth + 1));
    return matchValue(row[key], cond, depth + 1);
  });
}

function matchValue(value: unknown, cond: unknown, depth: number): boolean {
  if (depth > 20) throw new Error("filter nests deeper than 20 levels — cyclic or self-referential");
  if (cond instanceof RegExp) return typeof value === "string" && cond.test(value);
  if (cond && typeof cond === "object") {
    return Object.entries(cond as Record<string, unknown>).every(([op, operand]) => {
      if (op === "$eq") return value === operand;
      if (op === "$exists") return (value !== undefined) === Boolean(operand);
      if (op === "$ne") return value !== operand;
      if (op === "$nin") return !(operand as unknown[]).includes(value);
      if (op === "$in") return (operand as unknown[]).includes(value);
      if (op === "$lt") return typeof value === "number" && value < (operand as number);
      if (op === "$gt") return typeof value === "number" && value > (operand as number);
      throw new Error(`matcher does not implement ${op}`);
    });
  }
  return value === cond;
}

/**
 * Walk a filter and report every field matched by a regex.
 *
 * The behavioural checks below are the real assertions; this one pins the shape, so a future rewrite
 * that reintroduces `{ shareId: someRegex }` fails here even if it happens to be anchored today.
 */
function regexFields(filter: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 20) throw new Error("filter nests deeper than 20 levels — cyclic or self-referential");
  if (!filter || typeof filter !== "object") return out;
  for (const [key, cond] of Object.entries(filter as Record<string, unknown>)) {
    if (key === "$and" || key === "$or") {
      for (const c of cond as unknown[]) regexFields(c, out, depth + 1);
    } else if (cond instanceof RegExp) {
      out.push(key);
    }
  }
  return out;
}

/** Fields whose value *is* the access: never matched by a substring. */
const SECRET_SEARCH_FIELDS = ["shareId", "requestUploadToken"];

const ALL_MOCKS = [shareLinkFind, shareLinkCount, docFind, docCount, orgFind, projectFind, projectCount, projectUpdateMany];

beforeEach(() => {
  for (const m of ALL_MOCKS) m.mockReset();
  shareLinkCount.mockResolvedValue(0);
  docCount.mockResolvedValue(0);
  projectCount.mockResolvedValue(0);
  projectUpdateMany.mockResolvedValue({ acknowledged: true });
  shareLinkFind.mockReturnValue(query([]));
  docFind.mockReturnValue(query([]));
  orgFind.mockReturnValue(query([]));
  projectFind.mockReturnValue(query([]));
});

/** Run a listing and return the filter it asked Mongo to count — the same one it then finds with. */
async function filterFor(
  handler: (r: Request) => Promise<Response>,
  qs: string,
  count: ReturnType<typeof vi.fn>,
  find: ReturnType<typeof vi.fn>,
): Promise<Record<string, unknown>> {
  // Cleared here rather than by the caller: the links route resolves workspace and document names
  // with its own `DocModel.find`, so a previous case's lookup would otherwise sit at call 0.
  for (const m of ALL_MOCKS) m.mockClear();
  const res = await handler(req(qs));
  expect(res.status).toBe(200);
  expect(count).toHaveBeenCalledTimes(1);
  const filter = count.mock.calls[0][0] as Record<string, unknown>;
  // The count drives the `total` the oracle reads, and the find drives the rows; a fix that only
  // narrowed one of them would still answer the probe.
  expect(find.mock.calls[0][0]).toEqual(filter);
  return filter;
}

describe("GET /api/admin/data/links — ?q= is not an oracle over the share slug", () => {
  const row = { _id: new Types.ObjectId(), label: "Q3 investors", audience: "acme", shareId: SHARE_ID };

  test("a prefix of the slug does not keep its row; the whole slug does", async () => {
    // The oracle's first move: two characters, then extend. It must select nothing.
    for (const probe of [SHARE_ID.slice(0, 2), SHARE_ID.slice(0, 6), SHARE_ID.slice(0, 11), SHARE_ID.slice(1)]) {
      const filter = await filterFor(listLinks, `q=${probe}`, shareLinkCount, shareLinkFind);
      expect(matches(filter, row), `probe "${probe}" still selects the row`).toBe(false);
    }

    // The support workflow the redaction promised: paste the slug you were given, find the row.
    const whole = await filterFor(listLinks, `q=${SHARE_ID}`, shareLinkCount, shareLinkFind);
    expect(matches(whole, row)).toBe(true);
  });

  test("the slug match is whole and case-sensitive, and no regex touches a secret field", async () => {
    const filter = await filterFor(listLinks, `q=${SHARE_ID.toLowerCase()}`, shareLinkCount, shareLinkFind);
    // Base62 slugs are case-sensitive; folding case here would report a different link than the one
    // pasted, and would hand back a probe that is cheaper than the real value.
    expect(matches(filter, row)).toBe(false);
    expect(regexFields(filter)).not.toContain("shareId");
  });

  test("label and audience are still substring searches", async () => {
    const byLabel = await filterFor(listLinks, "q=investors", shareLinkCount, shareLinkFind);
    expect(matches(byLabel, row)).toBe(true);
    expect(regexFields(byLabel)).toEqual(expect.arrayContaining(["label", "audience"]));
  });
});

describe("GET /api/admin/data/docs — ?q= is not an oracle over the share slug", () => {
  const row = { _id: new Types.ObjectId(), title: "Series A deck", shareId: SHARE_ID };

  test("a prefix of the slug does not keep its row; the whole slug does", async () => {
    for (const probe of [SHARE_ID.slice(0, 2), SHARE_ID.slice(0, 11)]) {
      const filter = await filterFor(listDocs, `q=${probe}`, docCount, docFind);
      expect(matches(filter, row), `probe "${probe}" still selects the row`).toBe(false);
    }

    const whole = await filterFor(listDocs, `q=${SHARE_ID}`, docCount, docFind);
    expect(matches(whole, row)).toBe(true);
    expect(regexFields(whole)).not.toContain("shareId");
  });

  test("the title is still a substring search", async () => {
    const filter = await filterFor(listDocs, "q=Series", docCount, docFind);
    expect(matches(filter, row)).toBe(true);
    expect(regexFields(filter)).toContain("title");
  });
});

describe("GET /api/admin/data/projects — ?q= is not an oracle over the slug or the upload token", () => {
  const row = {
    _id: new Types.ObjectId(),
    name: "Acme inbound",
    slug: "acme-inbound",
    shareId: SHARE_ID,
    requestUploadToken: UPLOAD_TOKEN,
    isRequest: true,
  };

  test("a prefix of either token does not keep its row; either whole token does", async () => {
    for (const probe of [SHARE_ID.slice(0, 2), UPLOAD_TOKEN.slice(0, 2), UPLOAD_TOKEN.slice(0, 23)]) {
      const filter = await filterFor(listProjects, `q=${probe}`, projectCount, projectFind);
      expect(matches(filter, row), `probe "${probe}" still selects the row`).toBe(false);
    }

    const bySlug = await filterFor(listProjects, `q=${SHARE_ID}`, projectCount, projectFind);
    expect(matches(bySlug, row)).toBe(true);

    const byToken = await filterFor(listProjects, `q=${UPLOAD_TOKEN}`, projectCount, projectFind);
    expect(matches(byToken, row)).toBe(true);
    expect(regexFields(byToken)).not.toEqual(expect.arrayContaining(SECRET_SEARCH_FIELDS));
  });

  test("name and slug are still substring searches", async () => {
    const filter = await filterFor(listProjects, "q=inbound", projectCount, projectFind);
    expect(matches(filter, row)).toBe(true);
    expect(regexFields(filter)).toEqual(expect.arrayContaining(["name", "slug"]));
  });
});

describe("GET /api/admin/data/requests — ?q= is not an oracle over the slug or the upload token", () => {
  const row = {
    _id: new Types.ObjectId(),
    name: "Acme inbound",
    slug: "acme-inbound",
    shareId: SHARE_ID,
    requestUploadToken: UPLOAD_TOKEN,
    isRequest: true,
  };

  test("a prefix of either token does not keep its row; either whole token does", async () => {
    for (const probe of [UPLOAD_TOKEN.slice(0, 2), UPLOAD_TOKEN.slice(0, 23), SHARE_ID.slice(0, 2)]) {
      const filter = await filterFor(listRequests, `q=${probe}`, projectCount, projectFind);
      expect(matches(filter, row), `probe "${probe}" still selects the row`).toBe(false);
    }

    const byToken = await filterFor(listRequests, `q=${UPLOAD_TOKEN}`, projectCount, projectFind);
    expect(matches(byToken, row)).toBe(true);
    expect(regexFields(byToken)).not.toEqual(expect.arrayContaining(SECRET_SEARCH_FIELDS));
  });

  test("the search still narrows to request repos, and the name search still works", async () => {
    const filter = await filterFor(listRequests, "q=inbound", projectCount, projectFind);
    expect(matches(filter, row)).toBe(true);
    // A plain project that is not a request repo must not appear in this listing because it happens
    // to match the text — the discriminator was being deleted out from under the search.
    expect(matches(filter, { name: "Acme inbound", slug: "acme-inbound" })).toBe(false);
  });
});

describe("the four routes agree", () => {
  test("no listing ever matches a secret field with a regex", async () => {
    const probes = ["Ab", SHARE_ID, UPLOAD_TOKEN, "inbound"];
    const cases: Array<[(r: Request) => Promise<Response>, ReturnType<typeof vi.fn>, ReturnType<typeof vi.fn>]> = [
      [listLinks, shareLinkCount, shareLinkFind],
      [listDocs, docCount, docFind],
      [listProjects, projectCount, projectFind],
      [listRequests, projectCount, projectFind],
    ];
    for (const [handler, count, find] of cases) {
      for (const probe of probes) {
        const filter = await filterFor(handler, `q=${probe}`, count, find);
        for (const field of SECRET_SEARCH_FIELDS) {
          expect(regexFields(filter), `${field} is matched by a regex`).not.toContain(field);
        }
      }
    }
  });
});
