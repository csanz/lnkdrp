/**
 * The three PDF proxies would fetch any URL a document row named, and hand back the body.
 *
 * `/s/:shareId/pdf`, `/p/:shareId/:docId/pdf` and `/api/request-view/:token/docs/:docId/pdf` each
 * did a bare `await fetch(doc.blobUrl)` and returned `upstream.body` with the upstream status,
 * content-length and content-range. `blobUrl` was owner-supplied text that `PATCH /api/docs/:docId`
 * stored verbatim, so a document could be pointed at `http://169.254.169.254/latest/meta-data/` or
 * at any hostname inside the deployment's network, and then read back through a public share slug.
 *
 * Making the field unpatchable closed the *writer*. It did not close these, which is what this file
 * pins: the write-side allowlist (`isBlobStoreHost`) lived in exactly one file — the write path —
 * so the read side was protected only by the absence of a bad writer, and every row poisoned while
 * the field still was patchable is still in the database. Pinning `content-type: application/pdf`
 * stopped those bytes from *executing* on this origin; it never stopped them from being fetched.
 *
 * Two halves are pinned, because either alone is a hole:
 *  - a candidate that is not on the blob store must never be dereferenced at all (`fetch` not
 *    called, not merely a discarded response — the outbound request *is* the vulnerability);
 *  - the refusal must be the document's own 404, not a 500 and not a distinguishable error, and it
 *    must land ahead of the analytics writes so a download that cannot be served is not counted.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";

// --- the store ---------------------------------------------------------------------------------

/** What `isBlobStoreHost` is standing in for: one configured store, pinned by id. */
const STORE_HOST = "store.public.blob.vercel-storage.com";
const DOC_ID = "68c1f0aa0d2b4e0012abcd34";
const UPLOAD_ID = "68c1f0aa0d2b4e0012abcdaa";
const STORE_PDF = `https://${STORE_HOST}/docs/${DOC_ID}/uploads/${UPLOAD_ID}/file.pdf`;
/** Rows written before the store id was pinned live on the bare host — they must keep serving. */
const LEGACY_PDF = `https://blob.vercel-storage.com/docs/${DOC_ID}/uploads/${UPLOAD_ID}/file.pdf`;

/**
 * Deliberately allowed, and worth stating out loud: another tenant's Vercel Blob store is a public,
 * read-only, credential-free CDN, so a row pointing at one buys an attacker nothing their own
 * browser would not already fetch. The legacy host family is accepted for the pre-pinned rows
 * above, and this is the price. The thing being refused is an *internal* address.
 */
const OTHER_TENANT_PDF = "https://someoneelse.public.blob.vercel-storage.com/docs/x/file.pdf";

/** Every one of these is a row an actor could have written while `blobUrl` was still patchable. */
const HOSTILE = [
  ["the cloud metadata service over http", "http://169.254.169.254/latest/meta-data/"],
  ["the cloud metadata service over https", "https://169.254.169.254/latest/meta-data/"],
  ["loopback, where the app's own unauthenticated internals listen", "http://127.0.0.1:3000/api/plan"],
  ["a hostname that only resolves inside the deployment", "http://redis.internal:6379/"],
  ["an attacker-controlled public host", "https://attacker.example.com/collect"],
  ["the store host as a prefix of someone else's domain", `https://${STORE_HOST}.attacker.example.com/x`],
  ["the store host smuggled into userinfo", `https://${STORE_HOST}@attacker.example.com/x`],
  ["plain http to the real store, downgrade and all", `http://${STORE_HOST}/docs/x/file.pdf`],
  ["a file: URL", "file:///etc/passwd"],
  ["a relative path", `docs/${DOC_ID}/uploads/${UPLOAD_ID}/file.pdf`],
  ["a data: URL", "data:application/pdf;base64,JVBERi0="],
] as const;

// --- module mocks ------------------------------------------------------------------------------

// The real predicate's own contract (exact match on the configured store, failing closed in
// production) is covered by tests/upload/serverClientUploadRoute.test.ts. Here it stands in for a
// deployment whose store id *is* pinned, which is the production shape.
vi.mock("@/lib/blob/serverClientUploadRoute", () => ({
  isBlobStoreHost: (h: string) => h === STORE_HOST,
}));

const resolveShareLink = vi.fn();
const touchShareLink = vi.fn();
vi.mock("@/lib/share/links", () => ({
  resolveShareLink: (...a: unknown[]) => resolveShareLink(...a),
  touchShareLink: (...a: unknown[]) => touchShareLink(...a),
}));

const resolveProjectLink = vi.fn();
vi.mock("@/lib/share/projectLinks", () => ({
  resolveProjectLink: (...a: unknown[]) => resolveProjectLink(...a),
}));

const findProjectDocument = vi.fn();
vi.mock("@/lib/share/projectPublic", () => ({
  findProjectDocument: (...a: unknown[]) => findProjectDocument(...a),
  projectLinkPasswordEnabled: (link: { passwordHash?: unknown; passwordSalt?: unknown }) =>
    Boolean(link?.passwordHash) && Boolean(link?.passwordSalt),
  projectViewerKey: () => "viewer-key",
}));

vi.mock("@/lib/sharePassword", () => ({
  shareAuthCookieName: (id: string) => `share_auth_${id}`,
  shareAuthCookieValue: () => "unlock",
}));

const shareViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 0 }));
vi.mock("@/lib/models/ShareView", () => ({
  ShareViewModel: {
    updateOne: (...a: unknown[]) => shareViewUpdateOne(...a),
    findOne: () => ({ select: () => ({ lean: () => ({ catch: async () => null }) }) }),
  },
}));

const projectLinkViewUpdateOne = vi.fn(async (..._a: unknown[]) => ({ upsertedCount: 0 }));
vi.mock("@/lib/models/ProjectLinkView", () => ({
  ProjectLinkViewModel: { updateOne: (...a: unknown[]) => projectLinkViewUpdateOne(...a) },
}));

/** `DocModel` wears two shapes: an analytics `updateOne` on `/s`, a chained read on request-view. */
const docFindOne = vi.fn();
const docUpdateOne = vi.fn(async (..._a: unknown[]) => ({}));
vi.mock("@/lib/models/Doc", () => ({
  DocModel: {
    updateOne: (...a: unknown[]) => docUpdateOne(...a),
    findOne: (...a: unknown[]) => ({ select: () => ({ lean: async () => docFindOne(...a) }) }),
  },
}));

const projectFindOne = vi.fn();
vi.mock("@/lib/models/Project", () => ({
  ProjectModel: {
    findOne: (...a: unknown[]) => ({ select: () => ({ lean: async () => projectFindOne(...a) }) }),
  },
}));

vi.mock("@/lib/mongodb", () => ({ connectMongo: async () => undefined }));
vi.mock("@/lib/models/Org", () => ({ ensurePersonalOrgForUserId: async () => "org" }));
vi.mock("@/lib/activity/log", () => ({ recordActivity: async () => undefined }));
vi.mock("@/lib/share/ownerSide", () => ({ isOwnerSideViewer: async () => false }));
vi.mock("@/lib/gating/actor", () => ({ tryResolveAuthUserId: async () => null }));
vi.mock("@/lib/http/rateLimit", () => ({
  clientIpFromRequest: () => "203.0.113.7",
  rateLimit: async () => ({ ok: true, allowed: true, remaining: 10 }),
}));

import { GET as shareGet } from "@/app/s/[shareId]/pdf/route";
import { GET as projectGet } from "@/app/p/[shareId]/[docId]/pdf/route";
import { GET as requestViewGet } from "@/app/api/request-view/[token]/docs/[docId]/pdf/route";

// --- harness -----------------------------------------------------------------------------------

const SHARE_ID = "sl_abc123";
const PROJECT_SHARE_ID = "pl_room01";
const VIEW_TOKEN = "rv_token01";

const PDF_BYTES = "%PDF-1.7\nnot really a pdf, but the proxy never looks\n";

const fetchMock = vi.fn(
  async (_input?: unknown, _init?: unknown) =>
    new Response(PDF_BYTES, {
      status: 200,
      headers: { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length) },
    }),
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockImplementation(
    async (_input?: unknown, _init?: unknown) =>
      new Response(PDF_BYTES, {
        status: 200,
        headers: { "content-type": "application/pdf", "content-length": String(PDF_BYTES.length) },
      }),
  );
  projectFindOne.mockResolvedValue({ _id: "project" });
});

/**
 * Each route, reduced to the one thing this file is about: "this row says the bytes are at
 * `blobUrl` — do you go and get them?" Everything upstream of that question (link resolution, the
 * password gate, membership) is mocked open, because each route already has its own tests for it.
 */
const ROUTES = [
  {
    name: "/s/:shareId/pdf",
    arrange(blobUrl: string) {
      resolveShareLink.mockResolvedValue({
        refusal: null,
        link: { _id: "link", allowDownload: true, passwordHash: null, passwordSalt: null, isDefault: true, label: null },
        doc: { _id: DOC_ID, blobUrl, title: "Deck", fileName: "deck.pdf" },
      });
    },
    call(query = "") {
      return shareGet(new Request(`http://localhost/s/${SHARE_ID}/pdf${query}`), {
        params: Promise.resolve({ shareId: SHARE_ID }),
      });
    },
  },
  {
    name: "/p/:shareId/:docId/pdf",
    arrange(blobUrl: string) {
      resolveProjectLink.mockResolvedValue({
        refusal: null,
        link: { _id: "link", allowDownload: true, passwordHash: null, passwordSalt: null, isDefault: true, label: null },
        project: { _id: "project", name: "Data room", orgId: "org", isRequest: false },
      });
      findProjectDocument.mockResolvedValue({ _id: DOC_ID, blobUrl, title: "Deck", fileName: "deck.pdf", orgId: "org" });
    },
    call(query = "") {
      return projectGet(new Request(`http://localhost/p/${PROJECT_SHARE_ID}/${DOC_ID}/pdf${query}`), {
        params: Promise.resolve({ shareId: PROJECT_SHARE_ID, docId: DOC_ID }),
      });
    },
  },
  {
    name: "/api/request-view/:token/docs/:docId/pdf",
    arrange(blobUrl: string) {
      docFindOne.mockResolvedValue({ _id: DOC_ID, blobUrl, title: "Submission", fileName: "submission.pdf" });
    },
    call(query = "") {
      return requestViewGet(
        new Request(`http://localhost/api/request-view/${VIEW_TOKEN}/docs/${DOC_ID}/pdf${query}`),
        { params: Promise.resolve({ token: VIEW_TOKEN, docId: DOC_ID }) },
      );
    },
  },
] as const;

// --- the allowlist -----------------------------------------------------------------------------

describe.each(ROUTES)("$name dereferences only the blob store", (route) => {
  test("serves a PDF stored on the configured store", async () => {
    route.arrange(STORE_PDF);
    const res = await route.call();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(STORE_PDF);
  });

  test("still serves a row written before the store id was pinned", async () => {
    route.arrange(LEGACY_PDF);
    expect((await route.call()).status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("another tenant's public store is allowed — see OTHER_TENANT_PDF for why", async () => {
    route.arrange(OTHER_TENANT_PDF);
    expect((await route.call()).status).toBe(200);
  });

  test.each(HOSTILE)("never dereferences %s", async (_label, candidate) => {
    route.arrange(candidate);
    const res = await route.call();
    // The outbound request is the vulnerability, so this assertion is the point of the file: not
    // "the response was discarded" but "the server never went and asked".
    expect(fetchMock).not.toHaveBeenCalled();
    // A clean 404 on the document, not a 500 out of a `fetch` that could not resolve the host, and
    // not a distinct code that would tell a prober which rows are poisoned: the same answer a
    // document whose processing never finished already gives.
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "PDF not available" });
  });

  test("an empty blobUrl is still the same refusal", async () => {
    route.arrange("");
    const res = await route.call();
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// --- the refusal lands ahead of the writes -----------------------------------------------------

describe("a refused row is not counted as a download", () => {
  test("/s/:shareId/pdf writes no analytics for a poisoned row", async () => {
    ROUTES[0].arrange("http://169.254.169.254/latest/meta-data/");
    const res = await ROUTES[0].call("?download=1&botId=bot-1");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    // The check sits beside the missing-bytes 404, which is upstream of every counter: a download
    // that was never served must not appear in the owner's analytics as one that was.
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(touchShareLink).not.toHaveBeenCalled();
    expect(docUpdateOne).not.toHaveBeenCalled();
  });

  test("/p/:shareId/:docId/pdf writes no analytics for a poisoned row", async () => {
    ROUTES[1].arrange("http://169.254.169.254/latest/meta-data/");
    const res = await ROUTES[1].call("?download=1&botId=bot-1");
    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(shareViewUpdateOne).not.toHaveBeenCalled();
    expect(projectLinkViewUpdateOne).not.toHaveBeenCalled();
    expect(touchShareLink).not.toHaveBeenCalled();
  });
});
