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

/**
 * Every route that creates workspace content or spends credits, and the action each names.
 *
 * The first five were the first pass, and a review of it found three more: the list was written
 * from the routes the *dashboard* calls to make a document, which is not the same set as the routes
 * that mint a public link or bill the operator. `/api/requests` creates a project carrying two live
 * capability tokens — an upload URL and a view URL, both public to whoever holds them — and the
 * summary and compare reruns reserve AI credits exactly as `/api/uploads/:id/process` does (those
 * three files are now every caller of `reserveCreditsOrThrow`/`queueSummaryRerun`). Anything added to
 * the product that creates or spends belongs here on the day it is written, not on the day someone
 * reads the queue's enforcement again.
 */
const GATED_ROUTES: Array<[string, string]> = [
  ["src/app/api/docs/route.ts", "create a document"],
  ["src/app/api/uploads/route.ts", "upload a document"],
  ["src/app/api/uploads/[uploadId]/process/route.ts", "process a document"],
  ["src/app/api/docs/[docId]/links/route.ts", "share a document"],
  ["src/app/api/projects/route.ts", "create a project"],
  ["src/app/api/requests/route.ts", "create a request folder"],
  ["src/app/api/uploads/[uploadId]/summary/route.ts", "write a summary"],
  ["src/app/api/docs/[docId]/changes/[changeId]/rerun/route.ts", "rerun a comparison"],
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
    //
    // `insertOne(` is here because `/api/requests` writes with a raw `collection.insertOne` to dodge
    // a stale Mongoose schema in dev, so a list of Mongoose model methods matched nothing in it and
    // this assertion passed by finding no write at all. The two spend calls are on the list for the
    // same reason a write is: a reservation the operator pays for is a thing that already happened.
    for (const write of [
      ".create(",
      "insertMany(",
      "findOneAndUpdate(",
      "insertOne(",
      "reserveCreditsOrThrow(",
      "queueSummaryRerun(",
    ]) {
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
  test("every page entry point decides from the same module the routes do", () => {
    // The drift between these two *was* the bug. Whatever the queue means, it has to mean the
    // same thing to the shell and to the endpoints behind it — and to the root route, which is
    // outside the `(app)` group and for a while ran no gate at all.
    expect(read("src/lib/gating/entryGate.ts")).toContain('from "@/lib/gating/waitlist"');
    expect(read("src/app/(app)/layout.tsx")).toContain("enforceEntryGates");
    expect(read("src/app/page.tsx")).toContain("enforceEntryGates");
  });
});
