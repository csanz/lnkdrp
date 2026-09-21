/**
 * A document someone drops into a request repo used to arrive as a live public link.
 *
 * `POST /api/requests/:token/uploads` is the sign-free write side of a request repo: a stranger
 * holding the upload token gets a Doc and an Upload created in the owner's workspace. That Doc was
 * created with a `shareId` and no `shareEnabled`, so the schema default applied
 * (`src/lib/models/Doc.ts`: `shareEnabled: { type: Boolean, default: true }`). Nothing else in the
 * flow ever turned it off, and the public document namespace does not need a `ShareLink` row to
 * serve a slug: `resolveShareLink` falls back to `DocModel.findOne({ shareId })` and has
 * `ensureDefaultLink` materialise the missing row with `enabled: doc.shareEnabled !== false`
 * (`src/lib/share/links.ts`). Enabled. No password, no expiry, no sign-in — and no way back, since
 * the owner's doc page renders `DocSharePanel` only when the document did *not* arrive via a
 * request (`src/app/(app)/doc/[docId]/pageClient.tsx`).
 *
 * So every submission was a `/s/:shareId` link its recipient never chose and could not revoke. The
 * project half of this was already closed the same way — `src/app/api/requests/route.ts` writes the
 * repo itself `shareEnabled: false` — and this is the document half.
 *
 * The end-to-end shape is what matters here, not the field: asserting only "the create payload says
 * false" would pass against a `resolveShareLink` that ignored it. So the route's own create is run
 * first, the row it wrote is kept, and the real `resolveShareLink` is then pointed at the slug the
 * route minted. The mocked `DocModel.create` applies the schema default for an absent
 * `shareEnabled`, which is what makes these tests fail against the old code rather than pass
 * vacuously on a field that simply is not there.
 *
 * The last two tests are the other half of the bargain — the surfaces that *should* still reach the
 * document: the repo owner's view link (`/request-view/:token`) and its PDF route both match on
 * `receivedViaRequestProjectId`, never on `shareEnabled`, so turning sharing off withdraws the
 * public slug and nothing else.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { Types } from "mongoose";

const ORG = new Types.ObjectId();
const OWNER = new Types.ObjectId();
const PROJECT = new Types.ObjectId();
const UPLOAD_TOKEN = "rut_public_upload_token";
const VIEW_TOKEN = "rvt_owner_view_token";

/** In-memory rows, shared by the route under test and by the readers pointed at what it wrote. */
let docs: Record<string, any>[] = [];
let links: Record<string, any>[] = [];

/** Filters handed to Mongo by the request-view readers, so a test can read the query that ran. */
const docFindFilters: Record<string, unknown>[] = [];
const docFindOneFilters: Record<string, unknown>[] = [];

let slugCounter = 0;

function chain(value: unknown): Record<string, any> {
  const self: Record<string, any> = {
    select: () => self,
    sort: () => self,
    lean: async () => value,
  };
  return self;
}

/**
 * Good enough for the filters these paths actually issue: equality, ObjectId-by-string, and the
 * `{ $ne: true }` / `{ $ne: false }` pair. The `$ne` support is the load-bearing part — a reader
 * that scoped on `shareEnabled: { $ne: false }` would stop matching the moment the fix lands, and
 * that is exactly what the last two tests are here to catch.
 */
function matchDocs(filter: Record<string, any>): Record<string, any>[] {
  return docs.filter((d) =>
    Object.entries(filter).every(([key, want]) => {
      const have = d[key];
      if (want && typeof want === "object" && !(want instanceof Types.ObjectId) && "$ne" in want) {
        return have !== (want as { $ne: unknown }).$ne;
      }
      if (want instanceof Types.ObjectId) return String(have) === String(want);
      return have === want;
    }),
  );
}

vi.mock("@/lib/mongodb", () => ({ connectMongo: vi.fn(async () => undefined) }));
vi.mock("@/lib/debug", () => ({ debugLog: vi.fn(), debugError: vi.fn() }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: vi.fn() }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveUserActor: vi.fn(async () => null) }));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: vi.fn(async () => ({ orgId: ORG })) }));
vi.mock("@/lib/http/rateLimit", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/http/rateLimit")>();
  return { ...actual, rateLimit: vi.fn(async () => ({ ok: true, remaining: 9, retryAfterSec: 0 })) };
});
vi.mock("@/lib/uploads/recipientCaps", () => ({
  RECIPIENT_UPLOAD_LIMIT_CODE: "RECIPIENT_UPLOAD_LIMIT",
  checkRecipientUploadCap: vi.fn(async () => ({ ok: true as const })),
}));
vi.mock("@/lib/crypto/randomBase62", () => ({
  newShareId: () => `subSlug${++slugCounter}`,
  newSecretToken: () => "replace-upload-token",
  randomBase62: () => "ab12",
}));
vi.mock("@/lib/billing/planLimits", () => ({ checkLimit: vi.fn(async () => ({ ok: true, warning: null })) }));
vi.mock("@/lib/models/Upload", () => ({
  UploadModel: { create: vi.fn(async () => ({ _id: new Types.ObjectId() })) },
}));
vi.mock("@/lib/models/ShareView", () => ({ ShareViewModel: { updateOne: vi.fn(async () => ({})) } }));
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    findOne: (filter: Record<string, unknown>) => {
      const wantsUpload = filter.requestUploadToken === UPLOAD_TOKEN;
      const wantsView = filter.requestViewToken === VIEW_TOKEN;
      return chain(
        wantsUpload || wantsView
          ? { _id: PROJECT, orgId: ORG, userId: OWNER, name: "Diligence", description: "", isRequest: true }
          : null,
      );
    },
    updateOne: vi.fn(async () => ({ modifiedCount: 0 })),
  },
}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    /**
     * Stands in for the real model's schema defaults, which is the whole point of the mock: the
     * old route simply omitted `shareEnabled`, and Mongoose filled it with `true`. A mock that
     * stored `undefined` would make these tests pass against the bug.
     */
    create: vi.fn(async (payload: Record<string, any>) => {
      const row = { _id: new Types.ObjectId(), ...payload, shareEnabled: payload.shareEnabled ?? true };
      docs.push(row);
      return row;
    }),
    find: (filter: Record<string, unknown>) => {
      docFindFilters.push(filter);
      return chain(matchDocs(filter));
    },
    findOne: (filter: Record<string, unknown>) => {
      docFindOneFilters.push(filter);
      return chain(matchDocs(filter)[0] ?? null);
    },
    findByIdAndUpdate: vi.fn(async (id: unknown, update: Record<string, unknown>) => {
      const row = docs.find((d) => String(d._id) === String(id));
      if (row) Object.assign(row, update);
      return row ?? null;
    }),
    updateOne: vi.fn(async () => ({ acknowledged: true })),
  },
}));
vi.mock("@/lib/models/ShareLink", () => ({
  DOC_LINK_FILTER: { kind: { $ne: "project" } },
  ShareLinkModel: {
    findOne: (filter: Record<string, any>) =>
      chain(
        links.find((l) => {
          if (filter.shareId !== undefined && l.shareId !== filter.shareId) return false;
          if (filter.docId !== undefined && String(l.docId) !== String(filter.docId)) return false;
          if (filter.isDefault !== undefined && Boolean(l.isDefault) !== filter.isDefault) return false;
          return true;
        }) ?? null,
      ),
    create: vi.fn(async (payload: Record<string, unknown>) => {
      const row = { _id: new Types.ObjectId(), createdDate: new Date(), archivedAt: null, ...payload };
      links.push(row);
      return { toObject: () => row };
    }),
  },
}));
// The listing page is an async server component called directly; the header only has to import.
vi.mock("@/components/BrandHeader", () => ({ default: () => null }));

class NotFound extends Error {}
vi.mock("next/navigation", () => ({
  notFound: () => {
    throw new NotFound("notFound()");
  },
}));

beforeEach(() => {
  docs = [];
  links = [];
  docFindFilters.length = 0;
  docFindOneFilters.length = 0;
  slugCounter = 0;
  vi.stubGlobal("fetch", vi.fn(async () => new Response("%PDF-1.7", { status: 200 })));
});

/** Run the public upload route the way a stranger holding the link does, and return the new row. */
async function submit(): Promise<Record<string, any>> {
  const { POST } = await import("@/app/api/requests/[token]/uploads/route");
  const res = await POST(
    new Request(`http://localhost/api/requests/${UPLOAD_TOKEN}/uploads`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-forwarded-for": "203.0.113.42",
        "x-lnkdrp-botid": "bot-abcdefgh",
      },
      body: JSON.stringify({ originalFileName: "cap-table.pdf", contentType: "application/pdf", sizeBytes: 1024 }),
    }),
    { params: Promise.resolve({ token: UPLOAD_TOKEN }) },
  );
  expect(res.status).toBe(201);
  expect(docs.length).toBe(1);
  return docs[0]!;
}

describe("POST /api/requests/:token/uploads — a submission is not published", () => {
  test("the document is created with sharing off", async () => {
    const doc = await submit();

    expect(doc.shareEnabled).toBe(false);
    // The slug is still minted — `Doc.shareId` is unique and every reader expects one. It just
    // addresses nothing until the owner says otherwise.
    expect(typeof doc.shareId).toBe("string");
    expect(doc.shareId).toBeTruthy();
    expect(String(doc.receivedViaRequestProjectId)).toBe(PROJECT.toString());
  });

  test("the slug it mints is refused by the public document route", async () => {
    const doc = await submit();
    const { resolveShareLink } = await import("@/lib/share/links");

    const resolved = await resolveShareLink(String(doc.shareId));

    // `/s/:shareId` does `if (!resolved || resolved.refusal) notFound()`.
    expect(resolved).not.toBeNull();
    expect(resolved!.refusal).toBe("disabled");
    // The lazily-materialised default link is born off, and marked as off *because the document is
    // off* — the flag `setAllLinksEnabled` needs to tell "never published" apart from "revoked by
    // hand", should the product ever hand the owner that switch.
    expect(links.length).toBe(1);
    expect(links[0]!.enabled).toBe(false);
    expect(links[0]!.disabledByDocSwitch).toBe(true);
  });

  test("the repo owner's view link still lists it", async () => {
    const doc = await submit();
    const { default: RequestViewPage } = await import("@/app/request-view/[token]/page");

    await RequestViewPage({ params: Promise.resolve({ token: VIEW_TOKEN }) } as never);

    expect(docFindFilters.length).toBe(1);
    const filter = docFindFilters[0]!;
    // Scoped by the repo pointer and the two withdrawal flags — and by nothing else. A reader that
    // had grown a `shareEnabled` clause would drop the document the moment sharing went off.
    expect(String((filter as { receivedViaRequestProjectId?: unknown }).receivedViaRequestProjectId)).toBe(
      PROJECT.toString(),
    );
    expect(filter).not.toHaveProperty("shareEnabled");
    expect(matchDocs(filter).map((d) => String(d._id))).toEqual([String(doc._id)]);
  });

  test("the repo owner's view link still streams the bytes", async () => {
    const doc = await submit();
    // A host the route is willing to dereference (`blobFetchUrl` refuses anything else).
    doc.blobUrl = "https://store.public.blob.vercel-storage.com/cap-table.pdf";
    const { GET } = await import("@/app/api/request-view/[token]/docs/[docId]/pdf/route");

    const res = await GET(
      new Request(`http://localhost/api/request-view/${VIEW_TOKEN}/docs/${String(doc._id)}/pdf`),
      { params: Promise.resolve({ token: VIEW_TOKEN, docId: String(doc._id) }) },
    );

    expect(res.status).toBe(200);
    expect(docFindOneFilters.length).toBe(1);
    expect(docFindOneFilters[0]).not.toHaveProperty("shareEnabled");
  });
});
