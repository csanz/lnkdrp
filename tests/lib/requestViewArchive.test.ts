/**
 * Archiving a received document did not withdraw it from the request repo's view link.
 *
 * A request repo hands out two capability URLs: an upload token and a *view* token. The view token
 * is the read side — `/request-view/:token` lists what the repo has received and
 * `/api/request-view/:token/docs/:docId/pdf` streams the bytes. Both queries were scoped on
 * `isDeleted` alone.
 *
 * Archiving is the product's one way to take a document out of circulation without destroying it,
 * and everywhere else honours that: `resolveShareLink` turns `doc.isArchived` into the "archived"
 * refusal, and the data-room aggregation filters `doc.isArchived` out of its `$match`. These two
 * readers never learned it. So an owner who archived a sensitive upload saw it leave their lists
 * and their share links, while every holder of the request-view link went on listing it and
 * opening the PDF — indefinitely, because there is nothing else to revoke short of deleting the
 * document outright.
 *
 * The rule lives in the filter, not in the response mapping, so these are pinned as
 * filters-issued assertions (the style of tests/lib/crossTenantScoping.test.ts): assert on the
 * object handed to Mongo, plus — for the route — that no upstream fetch of the blob happens when
 * the document does not match.
 *
 * The second pair of tests covers the neighbour the same scoping missed: the project lookup for
 * the token itself, which accepted a request repo the owner had already deleted.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const PROJECT = new Types.ObjectId();
const DOC = new Types.ObjectId();
const TOKEN = "rvt_qX7m2kTb9s";

/** What the mocked models were asked for, in call order. */
const projectFindOneFilters: unknown[] = [];
const docFindOneFilters: unknown[] = [];
const docFindFilters: unknown[] = [];

/** `null` here stands for "the filter matched nothing" — the shape both fixes rely on. */
let projectRow: unknown = { _id: PROJECT, name: "Diligence", description: "", isRequest: true };
let docRow: unknown = { _id: DOC, blobUrl: "https://blob.example/x.pdf", title: "Cap table", fileName: "cap-table.pdf" };
let docRows: unknown[] = [];

function chain(value: unknown): Record<string, unknown> {
  const self: Record<string, unknown> = {
    select: () => self,
    sort: () => self,
    lean: async () => value,
  };
  return self;
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    findOne: (filter: unknown) => {
      projectFindOneFilters.push(filter);
      return chain(projectRow);
    },
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    findOne: (filter: unknown) => {
      docFindOneFilters.push(filter);
      return chain(docRow);
    },
    find: (filter: unknown) => {
      docFindFilters.push(filter);
      return chain(docRows);
    },
  },
}));
// The page is an async server component; we call it directly and read the element it returns, so
// the header only has to import cleanly. Stub it rather than drag `next/image` in.
vi.mock("@/components/BrandHeader", () => ({ default: () => null }));

class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("notFound()");
  },
}));

const upstreamFetch = vi.fn(async () => new Response("%PDF-1.7", { status: 200, headers: { "content-type": "application/pdf" } }));

beforeEach(() => {
  vi.clearAllMocks();
  projectFindOneFilters.length = 0;
  docFindOneFilters.length = 0;
  docFindFilters.length = 0;
  projectRow = { _id: PROJECT, name: "Diligence", description: "", isRequest: true };
  docRow = { _id: DOC, blobUrl: "https://blob.example/x.pdf", title: "Cap table", fileName: "cap-table.pdf" };
  docRows = [];
  vi.stubGlobal("fetch", upstreamFetch);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function pdfRequest() {
  return new Request(`http://localhost/api/request-view/${TOKEN}/docs/${DOC.toString()}/pdf`);
}

describe("GET /api/request-view/:token/docs/:docId/pdf", () => {
  test("the document lookup refuses an archived document", async () => {
    const { GET } = await import("@/app/api/request-view/[token]/docs/[docId]/pdf/route");

    await GET(pdfRequest(), { params: Promise.resolve({ token: TOKEN, docId: DOC.toString() }) });

    expect(docFindOneFilters.length).toBe(1);
    const filter = docFindOneFilters[0] as Record<string, unknown>;
    // Both withdrawal states, not just deletion. `$ne: true` rather than `false` because the field
    // is absent on documents written before the flag existed.
    expect(filter.isDeleted).toEqual({ $ne: true });
    expect(filter.isArchived).toEqual({ $ne: true });
    // Still bound to the repo the token names — the archive clause is an addition, not a swap.
    expect(String((filter as { receivedViaRequestProjectId?: unknown }).receivedViaRequestProjectId)).toBe(
      PROJECT.toString(),
    );
  });

  test("when the filter matches nothing the blob is never fetched", async () => {
    // What the database returns for an archived document once the clause is in place.
    docRow = null;
    const { GET } = await import("@/app/api/request-view/[token]/docs/[docId]/pdf/route");

    const res = await GET(pdfRequest(), { params: Promise.resolve({ token: TOKEN, docId: DOC.toString() }) });

    expect(res.status).toBe(404);
    // The point of the fix: no request leaves for the stored PDF, so the bytes cannot reach a
    // recipient holding the view link.
    expect(upstreamFetch).not.toHaveBeenCalled();
  });

  test("a live document is still served", async () => {
    const { GET } = await import("@/app/api/request-view/[token]/docs/[docId]/pdf/route");

    const res = await GET(pdfRequest(), { params: Promise.resolve({ token: TOKEN, docId: DOC.toString() }) });

    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(upstreamFetch).toHaveBeenCalledTimes(1);
  });

  test("the token is not honoured for a deleted request repo", async () => {
    const { GET } = await import("@/app/api/request-view/[token]/docs/[docId]/pdf/route");

    await GET(pdfRequest(), { params: Promise.resolve({ token: TOKEN, docId: DOC.toString() }) });

    const filter = projectFindOneFilters[0] as Record<string, unknown>;
    expect(filter.requestViewToken).toBe(TOKEN);
    expect(filter.isDeleted).toEqual({ $ne: true });
  });
});

describe("/request-view/:token listing", () => {
  test("the listing query carries the same withdrawal clauses as the PDF route", async () => {
    const { default: RequestViewPage } = await import("@/app/request-view/[token]/page");

    await RequestViewPage({ params: Promise.resolve({ token: TOKEN }) });

    expect(docFindFilters.length).toBe(1);
    const filter = docFindFilters[0] as Record<string, unknown>;
    expect(filter.isDeleted).toEqual({ $ne: true });
    // Without this the page kept advertising a document whose PDF the route now — correctly —
    // refuses, which reads to the recipient as a broken link rather than a withdrawn document.
    expect(filter.isArchived).toEqual({ $ne: true });
  });

  test("a deleted request repo 404s instead of rendering", async () => {
    projectRow = null;
    const { default: RequestViewPage } = await import("@/app/request-view/[token]/page");

    await expect(RequestViewPage({ params: Promise.resolve({ token: TOKEN }) })).rejects.toBeInstanceOf(NotFound);

    const filter = projectFindOneFilters[0] as Record<string, unknown>;
    expect(filter.isDeleted).toEqual({ $ne: true });
  });
});
