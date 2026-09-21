/**
 * An allowlist that only ever sees the first URL is not an allowlist.
 *
 * Five public routes read a URL off a document row and fetch it. They all check the host first, and
 * they all handed the result to a bare `fetch` — which follows redirects by default. So a stored
 * URL on the blob store that answered `302 Location: http://169.254.169.254/...` was still
 * dereferenced, and its body still streamed back to whoever asked. The check passed, and then the
 * request walked away from the thing that was checked.
 *
 * `fetchStoredBlob` follows the redirect itself and re-applies the allowlist to every hop. One hop
 * is allowed, because a blob store may legitimately hand off to a signed CDN URL; a chain is not,
 * because nothing we store needs two.
 *
 * The rows that make this reachable are real: `blobUrl` and `previewImageUrl` were patchable by any
 * actor, including an unauthenticated temp user, and nothing has swept the rows written then.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const STORE = "abc123.public.blob.vercel-storage.com";

vi.mock("@/lib/blob/serverClientUploadRoute", () => ({
  isBlobStoreHost: (host: string) => host === STORE,
}));

import { blobFetchUrl, fetchStoredBlob } from "@/lib/blob/fetchStoredBlob";

/** Queue of responses, oldest first; each `fetch` shifts one off. */
let queued: Array<{ status: number; location?: string }> = [];
const fetchMock = vi.fn(async (_input: unknown, _init?: unknown) => {
  const next = queued.shift() ?? { status: 200 };
  return {
    status: next.status,
    ok: next.status >= 200 && next.status < 300,
    headers: { get: (k: string) => (k.toLowerCase() === "location" ? (next.location ?? null) : null) },
  } as unknown as Response;
});

const urlsFetched = () => fetchMock.mock.calls.map((c) => String(c[0]));
const initOf = (n: number) => fetchMock.mock.calls[n]?.[1] as RequestInit | undefined;

beforeEach(() => {
  queued = [];
  fetchMock.mockClear();
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe("blobFetchUrl", () => {
  test("the store, and the legacy family, are ours", () => {
    expect(blobFetchUrl(`https://${STORE}/docs/a/preview.png`)?.hostname).toBe(STORE);
    expect(blobFetchUrl("https://blob.vercel-storage.com/x.pdf")?.hostname).toBe("blob.vercel-storage.com");
  });

  test("a host that merely ends with the CDN name is not the CDN", () => {
    // The suffix check is anchored on a dot for exactly this.
    expect(blobFetchUrl("https://blob.vercel-storage.com.attacker.example/x")).toBeNull();
    expect(blobFetchUrl("https://notblob.vercel-storage.com/x")).toBeNull();
  });

  test("plaintext, link-local and nonsense are refused", () => {
    expect(blobFetchUrl(`http://${STORE}/x.pdf`)).toBeNull();
    expect(blobFetchUrl("http://169.254.169.254/latest/meta-data/")).toBeNull();
    expect(blobFetchUrl("../../../etc/passwd")).toBeNull();
    expect(blobFetchUrl("")).toBeNull();
    expect(blobFetchUrl(null)).toBeNull();
  });
});

describe("fetchStoredBlob", () => {
  test("a plain read is one request, with redirects pinned", async () => {
    queued = [{ status: 200 }];

    const res = await fetchStoredBlob(`https://${STORE}/docs/a/file.pdf`);

    expect(res).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // `manual`, so the runtime cannot follow a hop behind our back.
    expect(initOf(0)?.redirect).toBe("manual");
  });

  test("a redirect that stays on the store is followed", async () => {
    // The legitimate case: a store handing off to a signed CDN URL.
    queued = [{ status: 302, location: `https://${STORE}/signed/abc` }, { status: 200 }];

    const res = await fetchStoredBlob(`https://${STORE}/docs/a/file.pdf`);

    expect(res?.status).toBe(200);
    expect(urlsFetched()).toEqual([`https://${STORE}/docs/a/file.pdf`, `https://${STORE}/signed/abc`]);
  });

  test("a redirect off the store is refused, and never requested", async () => {
    queued = [{ status: 302, location: "http://169.254.169.254/latest/meta-data/iam/" }];

    const res = await fetchStoredBlob(`https://${STORE}/docs/a/file.pdf`);

    // This is the hole: before, `fetch` followed this and handed back the body.
    expect(res).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(urlsFetched().some((u) => u.includes("169.254.169.254"))).toBe(false);
  });

  test("a relative Location is resolved against the store, not against nothing", async () => {
    queued = [{ status: 302, location: "/signed/abc" }, { status: 200 }];

    await fetchStoredBlob(`https://${STORE}/docs/a/file.pdf`);

    expect(urlsFetched()[1]).toBe(`https://${STORE}/signed/abc`);
  });

  test("a chain is refused even when every hop is on the store", async () => {
    // Each hop is individually fine; two of them is not something anything we store needs.
    queued = [
      { status: 302, location: `https://${STORE}/one` },
      { status: 302, location: `https://${STORE}/two` },
      { status: 200 },
    ];

    expect(await fetchStoredBlob(`https://${STORE}/docs/a/file.pdf`)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test("a response with no usable status is handed back, not treated as a redirect", async () => {
    // Defensive rather than hypothetical: a stub whose `headers.get` answers every key would
    // otherwise turn an ordinary read into a second request at whatever that answer resolved to.
    fetchMock.mockImplementationOnce(async () =>
      ({ ok: true, headers: { get: () => "image/png" } }) as unknown as Response,
    );

    const res = await fetchStoredBlob(`https://${STORE}/docs/a/preview.png`);

    expect(res).not.toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a pointer that is not ours is refused before any request goes out", async () => {
    expect(await fetchStoredBlob("https://attacker.example/collect.png")).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
