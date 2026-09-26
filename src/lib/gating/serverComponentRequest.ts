/**
 * A `Request` that the actor resolvers can actually read, built from a server component's context.
 *
 * The resolvers all take a `Request` because they were written for route handlers, where Next hands
 * them a `NextRequest`. A server component has no request object at all, so the pages that need an
 * actor synthesize one from `headers()`. That looks equivalent and is not, for one reason worth
 * writing down because it fails silently:
 *
 * `tryGetSessionClaims` reads the session with NextAuth's `getToken`, and `getToken` finds the
 * session cookie through `req.cookies` **only** — its `SessionStore` checks `cookies.getAll()`, then
 * `cookies instanceof Map`, then enumerates `cookies` as a plain object, and never once parses the
 * `cookie` *header*. A `new Request(url, { headers })` has no `cookies` property, so the store finds
 * nothing, `getToken` returns `null`, and the caller concludes the visitor is signed out. No error,
 * no warning: a signed-in owner is simply read as a stranger.
 *
 * That is what made `/integrations` flash. The page resolves Slack on the server precisely so the
 * first paint says "Manage" instead of guessing, `slackStateForPage` returned `null` every time
 * because of the above, and the card fell back to its neutral word and flipped a second later when
 * the browser's own fetch answered — the exact bug the server read was added to prevent.
 *
 * So the jar is attached explicitly. `cookies()` returns Next's `RequestCookies`, whose `getAll()`
 * is the first shape `SessionStore` looks for; the `cookie` header still comes along in `headers()`
 * for the resolvers that parse it themselves (the active-workspace cookie is read that way).
 */
import { cookies, headers } from "next/headers";

/**
 * Build a `Request` for `path` carrying this request's headers **and** its cookie jar.
 *
 * `path` is only ever used to make the URL well-formed and to label the request in a trace; nothing
 * routes on it. The host is a placeholder for the same reason.
 */
export async function serverComponentRequest(path: string): Promise<Request> {
  const [h, jar] = await Promise.all([headers(), cookies()]);
  const request = new Request(`http://localhost${path}`, { headers: h });
  // `Request` has no `cookies` of its own, so this defines rather than overwrites. Non-enumerable
  // and non-writable, to match how `NextRequest` exposes it.
  Object.defineProperty(request, "cookies", { value: jar });
  return request;
}
