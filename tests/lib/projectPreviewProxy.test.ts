/**
 * A data room published the first page of every document it held, permanently.
 *
 * `/p/:shareId` rendered each card's thumbnail straight from `previewImageUrl`, and
 * `/p/:shareId/:docId` did the same on its "still preparing a PDF viewer" fallback. That value is a
 * Vercel Blob URL on a public, unauthenticated CDN (`docs/<docId>/uploads/<uploadId>/preview.png`),
 * so the room's HTML handed every visitor a link-independent copy of the first page of every
 * document in it, with the internal document and upload ids spelled out in the path. Revoking,
 * expiring or password-protecting the link did nothing to a URL somebody had already saved.
 *
 * Two halves are pinned, because either alone is a hole:
 *  - the pages must not emit a stored blob URL at all (the source scan below — the leak was in the
 *    markup, so that is where it has to be checked);
 *  - `/p/:shareId/:docId/preview` must re-prove the link's gate on every request, in the same order
 *    the page and the PDF proxy use, so a locked room's thumbnails are not an inventory oracle.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const SHARE_ID = "pl_room01";
const MEMBER_DOC = "68c1f0aa0d2b4e0012abcd34";
const OUTSIDER_DOC = "68c1f0aa0d2b4e0012abcd99";
const UNLOCK_COOKIE = "the-unlock-cookie";
const BLOB_PREVIEW = `https://blob.vercel-storage.com/docs/${MEMBER_DOC}/uploads/68c1f0aa0d2b4e0012abcdaa/preview.png`;
/** Where a poisoned or legacy row points once the allowlisted first hop has done its job. */
const INTERNAL = "http://169.254.169.254/latest/meta-data/iam/security-credentials/";

/** A one-pixel-ish PNG: only the 8-byte signature matters to the route. */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);

// --- module mocks ------------------------------------------------------------------------------

const resolveProjectLink = vi.fn();
vi.mock("@/lib/share/projectLinks", () => ({
  resolveProjectLink: (...a: any[]) => (resolveProjectLink as any)(...a),
}));

const findProjectDocument = vi.fn();
vi.mock("@/lib/share/projectPublic", () => ({
  findProjectDocument: (...a: any[]) => (findProjectDocument as any)(...a),
  // The real predicate: it is pure, and it is the thing that decides "locked".
  projectLinkPasswordEnabled: (link: any) => Boolean(link?.passwordHash) && Boolean(link?.passwordSalt),
}));

vi.mock("@/lib/sharePassword", () => ({
  shareAuthCookieName: (id: string) => `share_auth_${id}`,
  shareAuthCookieValue: () => UNLOCK_COOKIE,
}));

vi.mock("@/lib/blob/serverClientUploadRoute", () => ({ isBlobStoreHost: (h: string) => h === "store.public.blob.vercel-storage.com" }));

import { GET } from "@/app/p/[shareId]/[docId]/preview/route";

// --- fixtures ----------------------------------------------------------------------------------

const openLink = { _id: "link", orgId: "org", passwordHash: null, passwordSalt: null };
const lockedLink = { _id: "link", orgId: "org", passwordHash: "hash", passwordSalt: "salt" };
const project = { _id: "project", name: "Data room", orgId: "org", isRequest: false };

const memberDoc = { _id: MEMBER_DOC, previewImageUrl: BLOB_PREVIEW, firstPagePngUrl: null };

function roomHolds(_project: unknown, docId: unknown) {
  return Promise.resolve(String(docId) === MEMBER_DOC ? memberDoc : null);
}

async function get(docId: string, opts: { cookie?: string } = {}) {
  return GET(
    new Request(`http://localhost/p/${SHARE_ID}/${docId}/preview`, {
      headers: opts.cookie ? { cookie: `share_auth_${SHARE_ID}=${opts.cookie}` } : {},
    }),
    { params: Promise.resolve({ shareId: SHARE_ID, docId }) },
  );
}

/** Status plus body, because "the same answer" has to mean the bytes too, not just the code. */
async function answer(docId: string, opts: { cookie?: string } = {}) {
  const res = await get(docId, opts);
  return { status: res.status, body: await res.text() };
}

/** What the fake store answers for a given URL; anything unlisted is a plain 200 PNG. */
const routes = new Map<string, { status: number; location?: string; body?: Buffer }>();
/** Every URL the stub was actually asked for, in order, including hops it followed. */
let requested: string[] = [];

/**
 * A `fetch` stub that emulates the platform's redirect handling rather than ignoring it.
 *
 * This is the whole point of the redirect test below: Node's `fetch` follows a 3xx unless the
 * caller asks for `redirect: "manual"`, so a stub that handed the 302 straight back would have
 * made the old bare-`fetch` version of this route look safe when it was not.
 */
const fetchMock = vi.fn(async (input: any, init?: any) => {
  let url = String(input);
  for (let hop = 0; hop < 5; hop += 1) {
    requested.push(url);
    const hit = routes.get(url) ?? { status: 200, body: PNG_BYTES };
    const isRedirect = hit.status >= 300 && hit.status < 400;
    // `Uint8Array`, not the `Buffer` itself: `BodyInit` does not accept Node's subclass.
    const res = new Response(isRedirect ? null : new Uint8Array(hit.body ?? PNG_BYTES), {
      status: hit.status,
      headers: isRedirect && hit.location ? { location: hit.location } : { "content-type": "image/png" },
    });
    if (init?.redirect === "manual" || !isRedirect || !hit.location) return res;
    url = new URL(hit.location, url).toString();
  }
  return new Response(null, { status: 508 });
});

beforeEach(() => {
  resolveProjectLink.mockReset();
  findProjectDocument.mockReset();
  findProjectDocument.mockImplementation(roomHolds as any);
  fetchMock.mockClear();
  routes.clear();
  requested = [];
  vi.stubGlobal("fetch", fetchMock);
  resolveProjectLink.mockResolvedValue({ link: openLink, project, refusal: null });
});

// --- the leak itself ---------------------------------------------------------------------------

describe("the data-room pages never emit a stored blob URL", () => {
  // The room page sits in a `(room)` route group so its Suspense boundary stops wrapping the
  // `[docId]` segment; the group is a folder, not a URL segment, so the page it names is the same
  // page at the same address.
  const PAGES = ["src/app/p/[shareId]/(room)/page.tsx", "src/app/p/[shareId]/[docId]/page.tsx"];

  test.each(PAGES)("%s renders previews through the same-origin proxy", (rel) => {
    const src = readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
    // Line-wise rather than a JSX parse: the expression is a template literal, so anything that
    // tries to match balanced braces gets it wrong, and the line is what a reviewer reads anyway.
    const imgSrcs = src.split("\n").filter((line) => /\bsrc=\{/.test(line));
    expect(imgSrcs.length, "no <img src> found — did the page stop rendering previews?").toBeGreaterThan(0);
    for (const value of imgSrcs) {
      // The stored fields are the leak. Whatever the expression is, it must not be one of them, and
      // it must be a path under this link.
      expect(value).not.toMatch(/previewImageUrl|firstPagePngUrl|blobUrl/);
      expect(value).toContain("/preview");
    }
  });
});

// --- the proxy's gate --------------------------------------------------------------------------

describe("/p/:shareId/:docId/preview re-proves the link", () => {
  test("serves a member document's preview on an open link, with a pinned type", async () => {
    const res = await get(MEMBER_DOC);
    expect(res.status).toBe(200);
    // Pinned from the bytes, never echoed from the store — the lesson the PDF proxy already learned.
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    // `private`, so no shared cache can hand a revoked room's first pages to the next asker.
    expect(res.headers.get("cache-control")).toMatch(/^private,/);
    expect(res.headers.get("cache-control")).not.toMatch(/s-maxage|stale-while-revalidate/);
  });

  test.each(["disabled", "expired", "archived", "project_gone"] as const)("a %s link gets nothing", async (refusal) => {
    resolveProjectLink.mockResolvedValue({ link: openLink, project, refusal });
    expect((await get(MEMBER_DOC)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a request repo gets nothing", async () => {
    resolveProjectLink.mockResolvedValue({ link: openLink, project: { ...project, isRequest: true }, refusal: null });
    expect((await get(MEMBER_DOC)).status).toBe(404);
  });

  test("an unknown slug gets nothing", async () => {
    resolveProjectLink.mockResolvedValue(null);
    expect((await get(MEMBER_DOC)).status).toBe(404);
  });

  test("a locked room answers every candidate id identically, and is not asked what it holds", async () => {
    resolveProjectLink.mockResolvedValue({ link: lockedLink, project, refusal: null });
    const member = await answer(MEMBER_DOC);
    const outsider = await answer(OUTSIDER_DOC);
    expect(member).toEqual(outsider);
    expect(member.status).toBe(401);
    // Not even a timing difference to read: membership is never resolved while the gate is up.
    expect(findProjectDocument).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("behind the password the bytes come back", async () => {
    resolveProjectLink.mockResolvedValue({ link: lockedLink, project, refusal: null });
    expect((await get(MEMBER_DOC, { cookie: UNLOCK_COOKIE })).status).toBe(200);
  });

  test("a document that is not in this room is a 404, cookie or not", async () => {
    expect((await get(OUTSIDER_DOC)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("a preview URL that is not on the blob store is never dereferenced", async () => {
    // The SSRF half: `previewImageUrl` is owner-supplied text, and this route is public.
    findProjectDocument.mockResolvedValue({ _id: MEMBER_DOC, previewImageUrl: "http://169.254.169.254/latest/meta-data/" });
    expect((await get(MEMBER_DOC)).status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  test("an allowlisted pointer that redirects off the store is refused, not followed", async () => {
    // The second lock, and the one this route was missing. A host check only ever sees hop zero,
    // so a row on the store that answers `302 Location: http://169.254.169.254/...` was still
    // dereferenced by the bare `fetch` underneath it, and the body still came back through this
    // origin with our own content type pinned on it. `fetchStoredBlob` re-applies the allowlist to
    // every hop, so the internal address is never asked for at all.
    routes.set(BLOB_PREVIEW, { status: 302, location: INTERNAL });
    routes.set(INTERNAL, { status: 200, body: PNG_BYTES });

    expect((await get(MEMBER_DOC)).status).toBe(404);
    expect(requested).toEqual([BLOB_PREVIEW]);
  });

  test("upstream bytes that are not an image are refused rather than re-served", async () => {
    fetchMock.mockResolvedValueOnce(new Response("<script>alert(1)</script>", { status: 200, headers: { "content-type": "text/html" } }));
    expect((await get(MEMBER_DOC)).status).toBe(404);
  });
});

// --- the twins -----------------------------------------------------------------------------------

describe("the two preview proxies do not drift apart", () => {
  const TWINS = ["src/app/p/[shareId]/[docId]/preview/route.ts", "src/app/s/[shareId]/preview/route.ts"];

  test.each(TWINS)("%s dereferences the stored pointer through the shared helper", (rel) => {
    const src = readFileSync(path.resolve(__dirname, "../..", rel), "utf8");
    // Checked in the source, because what went wrong was not behaviour anyone could see from
    // outside: this route kept a local copy of the host allowlist that was correct on its own
    // terms, handed the URL to a bare `fetch`, and so read as covered while the other four routes
    // were converted around it. One place owns the rule; a second copy is the defect.
    expect(src).toContain("fetchStoredBlob");
    expect(src).not.toMatch(/\bawait fetch\(/);
  });
});
