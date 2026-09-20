/**
 * Dereferencing a URL we stored earlier, safely, in one place.
 *
 * Five public routes serve bytes by reading a URL off a document row and fetching it: the two PDF
 * proxies, the request-repo PDF route, the OG image and the project preview. All five are reachable
 * by a stranger holding only a link, so all five are asking a server we own to make an outbound
 * request on a caller's behalf, which is the shape of every SSRF.
 *
 * Two locks, and the second one was missing.
 *
 * **The host allowlist.** `blobUrl` and `previewImageUrl` were patchable once, by any actor
 * including an unauthenticated temp user, so a poisoned row could point anywhere. The write path is
 * closed now, but rows written while it was open are still in the database, which is why the read
 * side checks too rather than trusting the field.
 *
 * **The redirect.** `fetch` follows redirects by default, so an allowlisted URL that answers 302 to
 * `http://169.254.169.254/...` was still dereferenced and its body still streamed back. The
 * allowlist only ever saw the first hop. This is the half that was missing: each route validated
 * the URL and then handed it to a `fetch` that would happily walk away from it.
 *
 * So the redirect is followed here, by hand, with the same allowlist applied to every hop. One hop
 * is allowed because a blob store may legitimately redirect to a signed CDN URL; a second is
 * refused, because nothing we store needs two and a chain is how this gets interesting.
 */
import { isBlobStoreHost } from "@/lib/blob/serverClientUploadRoute";

/** Vercel Blob's public CDN, and the bare host on rows written before the store id was pinned. */
const VERCEL_BLOB_HOST = "blob.vercel-storage.com";

/** How many redirects to follow. One is a signed-CDN hand-off; two is somebody being clever. */
const MAX_HOPS = 1;

/**
 * The URL if we are willing to dereference it, or null.
 *
 * Null is not an error worth reporting to the caller of the route: it means the stored pointer is
 * not ours, which from a recipient's side is indistinguishable from a document whose bytes are not
 * ready. Every caller answers its own "not available" rather than a 500, so a refused row is never
 * an oracle either.
 */
export function blobFetchUrl(candidate: string | null | undefined): URL | null {
  if (typeof candidate !== "string" || !candidate) return null;
  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase();
  if (isBlobStoreHost(host)) return url;
  // The legacy family, for rows written before the store id was pinned. Another tenant's store is a
  // public, read-only, credential-free CDN, so it buys an attacker nothing their own browser would
  // not already give them. The suffix check is anchored on a dot so
  // `blob.vercel-storage.com.attacker.example` is not a match.
  return host === VERCEL_BLOB_HOST || host.endsWith(`.${VERCEL_BLOB_HOST}`) ? url : null;
}

/**
 * Fetch a stored blob, refusing to follow a redirect off the store.
 *
 * Returns null when the pointer, or anywhere it leads, is not ours. Callers answer their own
 * "not available" on null rather than distinguishing the reasons.
 */
export async function fetchStoredBlob(candidate: string | null | undefined, init?: RequestInit): Promise<Response | null> {
  let url = blobFetchUrl(candidate);
  if (!url) return null;

  for (let hop = 0; ; hop += 1) {
    const res = await fetch(url, { ...init, redirect: "manual", cache: "no-store" });
    // Only a response that actually says it is a redirect is treated as one. Written as "is it a
    // 3xx" rather than "is it not a 2xx" on purpose: a response whose status is missing or not a
    // number must fall through to the caller untouched, not into the redirect branch, where it
    // would take whatever `location` happens to return and fetch again.
    const status = typeof res.status === "number" ? res.status : 0;
    if (status < 300 || status >= 400) return res;
    if (hop >= MAX_HOPS) return null;

    const location = res.headers.get("location");
    if (typeof location !== "string" || !location) return res;
    // Resolved against the current URL, because a store may answer a relative `location`. The
    // result goes through the same allowlist: a redirect is a new request to a new host, and the
    // check that let us make the first one says nothing about the second.
    let next: URL | null = null;
    try {
      next = blobFetchUrl(new URL(location, url).toString());
    } catch {
      return null;
    }
    if (!next) return null;
    url = next;
  }
}
