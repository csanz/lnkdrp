/**
 * `GET /api/tags/by-slug/:slug/items` must return the tag's whole contents.
 *
 * Both queries in that route used to end in `.limit(200)` with nothing in the response to say so.
 * `/tag/:slug` counts the rows it is handed and prints that as the tag's size, so past 200 the page
 * said "200 items" about a tag the sidebar, `/tags` and the delete confirmation all agreed was
 * bigger (`countLiveAssignments` counts every live assignment), and the documents past the cut,
 * the least recently updated ones, appeared on the only page that lists what carries a tag and in
 * the MCP's `list_docs { tag }` filter, which resolves through the same route, nowhere at all.
 *
 * Mongo is stubbed by a chain that honours `.limit()` if the route calls it, so a restored cap
 * fails here the way it failed in the product: in the rows and in the count, not in a grep.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId().toString();
const TAG_ID = new Types.ObjectId();

type Row = Record<string, unknown> & { _id: Types.ObjectId; updatedDate: Date };

/** Every `.limit()` the route asks for is applied, so an uncapped route is the only passing one. */
function collection(rows: () => Row[]) {
  return {
    find: (filter: { _id?: { $in?: Types.ObjectId[] } }) => {
      const wanted = new Set((filter._id?.$in ?? []).map(String));
      let kept = rows().filter((r) => wanted.has(String(r._id)));
      const q = {
        select: () => q,
        sort: () => {
          kept = [...kept].sort((a, b) => b.updatedDate.getTime() - a.updatedDate.getTime());
          return q;
        },
        limit: (n: number) => {
          kept = kept.slice(0, n);
          return q;
        },
        lean: async () => kept,
      };
      return q;
    },
  };
}

let docRows: Row[] = [];
let projectRows: Row[] = [];

const targetsForTag = vi.fn(async () => ({
  docIds: docRows.map((d) => String(d._id)),
  projectIds: projectRows.map((p) => String(p._id)),
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/db/mongoRequestLogger", () => ({
  withMongoRequestLogging: (_req: unknown, fn: () => unknown) => fn(),
}));
vi.mock("@/lib/gating/actor", () => ({
  resolveActor: vi.fn(async () => ({ kind: "user", orgId: ORG, userId: new Types.ObjectId().toString() })),
  applyTempUserHeaders: (res: unknown) => res,
}));
vi.mock("@/lib/models/Doc", () => ({ DocModel: collection(() => docRows) }));
vi.mock("@/lib/models/Project", () => ({ ProjectModel: collection(() => projectRows) }));
vi.mock("@/lib/models/Tag", () => ({
  TagModel: {
    findOne: () => ({
      lean: async () => ({ _id: TAG_ID, name: "Diligence", slug: "diligence", color: "jade" }),
    }),
  },
}));
vi.mock("@/lib/tags/service", async () => {
  const actual = await vi.importActual<typeof import("@/lib/tags/service")>("@/lib/tags/service");
  return { toTagDTO: actual.toTagDTO, targetsForTag };
});

const { GET } = await import("@/app/api/tags/by-slug/[slug]/items/route");

/** `n` documents, each updated a day further back, so the truncated ones are the oldest. */
function docs(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: new Types.ObjectId(),
    title: `Memo ${i + 1}`,
    currentVersion: 1,
    isArchived: false,
    updatedDate: new Date(Date.UTC(2026, 8, 22) - i * 86_400_000),
  }));
}

function projects(n: number): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    _id: new Types.ObjectId(),
    name: `Room ${i + 1}`,
    slug: `room-${i + 1}`,
    description: "",
    docCount: 0,
    updatedDate: new Date(Date.UTC(2026, 8, 22) - i * 86_400_000),
  }));
}

async function items() {
  const res = await GET(new Request("http://localhost/api/tags/by-slug/diligence/items"), {
    params: Promise.resolve({ slug: "diligence" }),
  });
  return (await res.json()) as {
    tag: { name: string; count?: number };
    docs: Array<{ id: string; title: string }>;
    projects: Array<{ id: string; name: string }>;
  };
}

beforeEach(() => {
  docRows = [];
  projectRows = [];
});

describe("a tag page lists everything that carries the tag", () => {
  test("the 201st document is on the page, not quietly missing from it", async () => {
    docRows = docs(201);
    const oldest = String(docRows[200]._id);

    const json = await items();

    expect(json.docs).toHaveLength(201);
    // The cap took the least recently updated first, which is exactly the document nobody would
    // think to go looking for.
    expect(json.docs.map((d) => d.id)).toContain(oldest);
  });

  test("projects are capped the same way, so a big folder set truncates too", async () => {
    projectRows = projects(201);

    const json = await items();

    expect(json.projects).toHaveLength(201);
  });

  test("the number the page derives is the number the rest of the workspace shows", async () => {
    // `countLiveAssignments` counts every live assignment, so the sidebar, /tags and the delete
    // confirmation all say 203 for this tag. The page says `docs.length + projects.length`.
    docRows = docs(201);
    projectRows = projects(2);

    const json = await items();

    expect(json.docs.length + json.projects.length).toBe(203);
    // And the tag now carries the count itself, so nothing has to infer a tag's size from the
    // length of a list it cannot tell is complete.
    expect(json.tag.count).toBe(203);
  });

  test("the usual small tag is unchanged: newest updated first, still all of it", async () => {
    docRows = docs(3);
    projectRows = projects(1);

    const json = await items();

    expect(json.docs.map((d) => d.title)).toEqual(["Memo 1", "Memo 2", "Memo 3"]);
    expect(json.projects.map((p) => p.name)).toEqual(["Room 1"]);
    expect(json.tag.count).toBe(4);
  });
});
