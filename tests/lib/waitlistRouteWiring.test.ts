/**
 * The early-access queue has to be a gate, not a redirect.
 *
 * `src/app/(app)/layout.tsx` sent a queued account to `/waitlist`, and that was the whole
 * enforcement: a decoration on one React layout. The account was real, signed in, and every API
 * route answered it normally — so a queued person could create documents, upload PDFs, publish
 * share links and spend the operator's AI credits by calling the endpoints the app itself calls.
 * An `lnk_` key minted by that account did the same without a browser involved at all.
 *
 * `forbidWaitlisted` (src/lib/gating/waitlist.ts) is the gate. What is pinned here is not the
 * gate's own logic — tests/lib/waitlistGate.test.ts does that — but the wiring, because a gate
 * nothing calls is exactly the shape the bug already had once. Each of these routes is a place a
 * queued account could otherwise still create something or spend something.
 *
 * Reads stay open on purpose. Someone in the queue must still be able to load `/waitlist`, see
 * their position, reach account settings and sign out.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

const REPO_ROOT = path.resolve(__dirname, "../..");

/** Every route that creates workspace content or spends credits, and the action each names. */
const GATED_ROUTES: Array<[string, string]> = [
  ["src/app/api/docs/route.ts", "create a document"],
  ["src/app/api/uploads/route.ts", "upload a document"],
  ["src/app/api/uploads/[uploadId]/process/route.ts", "process a document"],
  ["src/app/api/docs/[docId]/links/route.ts", "share a document"],
  ["src/app/api/projects/route.ts", "create a project"],
];

/** Approvals that must clear the gate's cache, or the button looks broken for 15 seconds. */
const INVALIDATING_ROUTES = [
  "src/app/api/admin/waitlist/[userId]/approve/route.ts",
  "src/app/api/org-invites/claim/route.ts",
];

function read(relative: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
}

describe("the queue is enforced where things are created", () => {
  test.each(GATED_ROUTES)("%s refuses a queued account", (relative) => {
    const source = read(relative);
    expect(source).toContain('from "@/lib/gating/waitlist"');
    expect(source).toMatch(/forbidWaitlisted\(\s*actor\s*,/);
  });

  test.each(GATED_ROUTES)("%s names the action it is refusing", (relative, action) => {
    // An agent — or a person — told only "forbidden" retries. Told which action is closed, they
    // can act on it. Same reasoning as `forbidApiKey`.
    expect(read(relative)).toContain(`forbidWaitlisted(actor, "${action}")`);
  });

  test.each(GATED_ROUTES)("%s refuses before it writes", (relative) => {
    const source = read(relative);
    // Only the handler body, not the helpers these files define above it — a `findOneAndUpdate`
    // inside a helper says nothing about the order things happen in at request time.
    const handlerAt = source.indexOf("export async function POST");
    expect(handlerAt).toBeGreaterThan(-1);
    const handler = source.slice(handlerAt);

    const gate = handler.indexOf("forbidWaitlisted(actor");
    expect(gate).toBeGreaterThan(-1);
    // A write must come after the gate. A refusal that lands after the row exists is an error
    // message, not a gate.
    for (const write of [".create(", "insertMany(", "findOneAndUpdate("]) {
      const at = handler.indexOf(write);
      if (at === -1) continue;
      expect(at).toBeGreaterThan(gate);
    }
  });
});

describe("approving someone takes effect now", () => {
  test.each(INVALIDATING_ROUTES)("%s clears the cached answer", (relative) => {
    const source = read(relative);
    // The gate caches "is this account queued" for 15s, the same shape as the membership cache.
    // Without this the person is let in by the database and still refused by the gate, which reads
    // as a broken Approve button rather than a stale cache.
    expect(source).toContain("accessStatusChanged(");
  });
});

describe("the page shell and the API agree", () => {
  test("the layout decides from the same module the routes do", () => {
    // The drift between these two *was* the bug. Whatever the queue means, it has to mean the
    // same thing to the shell and to the endpoints behind it.
    expect(read("src/app/(app)/layout.tsx")).toContain('from "@/lib/gating/waitlist"');
  });
});
