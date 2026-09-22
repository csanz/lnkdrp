/**
 * The document page has to hear about its own document changing.
 *
 * `/doc/:docId` is the page most likely to be open when an agent acts on that document, and it was
 * the one surface with no realtime path for its own content. Its hydrate loop stops as soon as the
 * doc is `ready` with a share id, and its 900ms replace poll is gated on `replaceUploadId` — state
 * only the tab that *started* a replacement ever sets. Both encode "the only writer is the person
 * looking at the page", which is exactly what the MCP server exists to break: an
 * `lnkdrp_replace_pdf` left the version badge, page count, preview and PDF iframe on the previous
 * version, and an `lnkdrp_set_share_access` left `DocSharePanel` (pure props off `doc`, no fetch of
 * its own) showing the old switches, until someone reloaded. The sidebar row updated underneath it,
 * because `LeftSidebar` does subscribe, so the open page was visibly the stale thing on screen.
 *
 * A change arrives by one of two routes, so both are pinned here:
 *
 * 1. **The `doc` frame** — `realtime/server.ts` watches `updateDescription.updatedFields.status`,
 *    so a replacement's `preparing` → `ready` flip broadcasts one. Before the fix the only
 *    `subscribeRealtime("doc", …)` in `src/` was the Activity feed's.
 * 2. **Activity rows** — archiving, the share switches and the share password never touch
 *    `status`, so no `doc` frame is emitted for them at all. The page's one activity subscription
 *    matched `summary.generated`, and the link-count one matched `share_link.` — and `share.updated`
 *    and `share.password_*` start with neither, which is how a share change fell between them.
 *
 * The second half of this file is the part that keeps the list honest: the event types are string
 * literals written at the API routes, so the set on the page is pinned against the routes that
 * write them. A renamed event type would otherwise silently stop refreshing the page, which is the
 * same failure in a new costume.
 */
import fs from "node:fs";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { REMOTE_DOC_CHANGE_ACTIVITY } from "@/app/(app)/doc/[docId]/pageClient";

const REPO_ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

const PAGE_CLIENT = "src/app/(app)/doc/[docId]/pageClient.tsx";

describe("the doc page subscribes to changes made to its own document", () => {
  const source = read(PAGE_CLIENT);

  test("it listens for `doc` frames, not only the Activity feed", () => {
    expect(source).toContain('subscribeRealtime("doc"');
  });

  test("the `doc` handler is filtered to this document", () => {
    // A workspace-wide refetch on every other document's status flip would be a refetch storm
    // during a bulk import; the frame carries an id precisely so it can be filtered.
    expect(source).toMatch(/f\.doc\.id !== docRef\.current\.id/);
  });

  test("a matching frame refetches the full doc", () => {
    // `refreshDocFull()` is what re-reads version, page count, preview, share switches and
    // projects. Subscribing without calling it would be a listener that changes nothing.
    const at = source.indexOf('subscribeRealtime("doc"');
    const effect = source.slice(Math.max(0, at - 1200), at + 1200);
    expect(effect).toContain("refreshDocFull()");
  });

  test("the activity subscription is wider than `summary.generated` and `share_link.`", () => {
    expect(source).toContain("REMOTE_DOC_CHANGE_ACTIVITY.has(");
  });
});

describe("REMOTE_DOC_CHANGE_ACTIVITY covers what the routes actually write", () => {
  test("a replacement processed by the pipeline", () => {
    expect(read("src/app/api/uploads/[uploadId]/process/route.ts")).toContain('? "doc.replaced"');
    expect(REMOTE_DOC_CHANGE_ACTIVITY.has("doc.replaced")).toBe(true);
    expect(REMOTE_DOC_CHANGE_ACTIVITY.has("doc.processed")).toBe(true);
  });

  test("archive and unarchive", () => {
    expect(read("src/app/api/docs/[docId]/route.ts")).toContain('body.isArchived ? "doc.archived" : "doc.unarchived"');
    expect(REMOTE_DOC_CHANGE_ACTIVITY.has("doc.archived")).toBe(true);
    expect(REMOTE_DOC_CHANGE_ACTIVITY.has("doc.unarchived")).toBe(true);
  });

  test("the share switches (`set_share_access`)", () => {
    expect(read("src/app/api/docs/[docId]/route.ts")).toContain('type: "share.updated"');
    expect(REMOTE_DOC_CHANGE_ACTIVITY.has("share.updated")).toBe(true);
  });

  test("the share password", () => {
    const route = read("src/app/api/docs/[docId]/share-password/route.ts");
    expect(route).toContain('type: "share.password_set"');
    expect(route).toContain('type: "share.password_cleared"');
    expect(REMOTE_DOC_CHANGE_ACTIVITY.has("share.password_set")).toBe(true);
    expect(REMOTE_DOC_CHANGE_ACTIVITY.has("share.password_cleared")).toBe(true);
  });

  test("none of these start with `share_link.`, which is why the old filter missed them", () => {
    // The page already had a `share_link.`-prefixed subscription for its link *count*. It reads
    // like it covers sharing, and covers none of this.
    for (const type of REMOTE_DOC_CHANGE_ACTIVITY) {
      expect(type.startsWith("share_link.")).toBe(false);
    }
  });
});
