/**
 * A session cookie that a `Request` carries but NextAuth cannot find.
 *
 * `/integrations` resolves Slack on the server so the first paint says "Manage" rather than guessing.
 * It did that from the day it was written and the card still flashed a neutral "Open" and flipped a
 * second later, because the server read returned `null` every single time for a signed-in owner.
 *
 * The cause is one asymmetry in `getToken`: its `SessionStore` looks for the session cookie on
 * `req.cookies` — `getAll()`, then a `Map`, then plain-object keys — and never parses the `cookie`
 * *header*. Route handlers are fine because Next hands them a `NextRequest`, which has `.cookies`. A
 * server component has no request at all, so it builds one from `headers()`, and a
 * `new Request(url, { headers })` has no `.cookies`. The store finds nothing, `getToken` returns
 * `null`, and the page concludes the visitor is signed out. Nothing throws and nothing is logged.
 *
 * So the two halves are pinned here. The first test is the trap: if a future next-auth starts
 * reading the header, it fails and `serverComponentRequest` can go. The second is the contract the
 * helper sells. The third keeps the caller honest, because the bug is invisible in the browser —
 * the page still works, it just lies for one paint, which is exactly the kind of regression that
 * survives review.
 */
import fs from "node:fs";
import path from "node:path";

import { getToken } from "next-auth/jwt";
import { describe, expect, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const COOKIE_NAME = "next-auth.session-token";
const TOKEN = "a-session-token";

/** The headers a server component gets from `headers()`: the cookie is present, as a header. */
function serverHeaders(): Headers {
  return new Headers({ cookie: `${COOKIE_NAME}=${TOKEN}; ld_active_org=6500000000000000000000aa` });
}

/** `raw: true` returns the cookie's value without decrypting it, so no secret has to be real. */
function read(req: Request) {
  return getToken({ req: req as unknown as Parameters<typeof getToken>[0]["req"], secret: "not-a-real-secret", raw: true });
}

describe("a server component's Request and the session cookie", () => {
  test("a Request built from headers alone hides the session from getToken", async () => {
    const bare = new Request("http://localhost/integrations", { headers: serverHeaders() });
    // The cookie is right there on the request, and it is still not found. This is the whole bug.
    expect(bare.headers.get("cookie")).toContain(COOKIE_NAME);
    expect(await read(bare)).toBeNull();
  });

  test("the same Request with a cookie jar attached gives getToken the session", async () => {
    const withJar = new Request("http://localhost/integrations", { headers: serverHeaders() });
    // The shape `cookies()` returns: `getAll()` yielding `{ name, value }`, which is the first thing
    // `SessionStore` reaches for.
    Object.defineProperty(withJar, "cookies", {
      value: { getAll: () => [{ name: COOKIE_NAME, value: TOKEN }] },
    });
    expect(await read(withJar)).toBe(TOKEN);
  });

  test("the pages that need an actor on the server go through the helper", () => {
    // `pageState` is the one this bug was found in; it must not go back to building its own.
    const src = fs.readFileSync(path.join(ROOT, "src/lib/slack/pageState.ts"), "utf8");
    expect(src).toContain("serverComponentRequest");
    expect(src).not.toMatch(/new Request\(/);
  });
});
