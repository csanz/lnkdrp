/**
 * Every document-scoped activity row names the room the document lives in
 * (docs/prds/lnkdrp-project-home.md, decision 2).
 *
 * A project's own feed is `GET /api/activity?projectId=<project>`, and that route filters on the
 * stored `ActivityEvent.projectId` (src/app/api/activity/route.ts). The project-home work stamped
 * the creation and replacement rows and stopped there, so a data room's feed was missing "new
 * link", "link revoked", "sharing changed", "archived", "deleted" and "tagged" for its own
 * documents: those writers passed `docId` and `title` only and the column stayed null.
 *
 * Source contracts, like tests/lib/docCreateIntoProject.test.ts, because these handlers are large
 * and mocked end to end elsewhere. The first half pins each individual writer. The second half is
 * the one that earns its keep over time: it walks every `recordActivity({ ... })` call in these
 * files and fails when one mentions `docId` without mentioning `projectId`, so a writer added later
 * cannot quietly forget the room.
 *
 * The stamp is always conditional. A document that lives in no project has no home to name, and
 * those rows keep `projectId` null exactly as they did before.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function source(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

const DOC_ROUTE = "src/app/api/docs/[docId]/route.ts";
const LINKS_ROUTE = "src/app/api/docs/[docId]/links/route.ts";
const LINK_ROUTE = "src/app/api/docs/[docId]/links/[linkId]/route.ts";
const LINKS_SHARED = "src/app/api/docs/[docId]/links/shared.ts";
const TAGS_ROUTE = "src/app/api/tags/assignments/route.ts";

/**
 * The `recordActivity({ ... })` call whose argument object contains `anchor`.
 *
 * Slices back to the nearest `recordActivity(` and forward to the brace that closes its argument,
 * so an assertion about one writer cannot pass on a neighbouring writer's `projectId`.
 */
function writerCall(src: string, anchor: string): string {
  const at = src.indexOf(anchor);
  expect(at, `no writer found for ${anchor}`).toBeGreaterThan(-1);
  const start = src.lastIndexOf("recordActivity(", at);
  expect(start, `no recordActivity( before ${anchor}`).toBeGreaterThan(-1);
  return sliceCall(src, start);
}

/** The `recordActivity(` call that starts at `start`, up to the brace closing its argument. */
function sliceCall(src: string, start: number): string {
  let depth = 0;
  let i = src.indexOf("{", start);
  for (; i < src.length; i += 1) {
    if (src[i] === "{") depth += 1;
    else if (src[i] === "}") {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return src.slice(start, i + 1);
}

/** Every `recordActivity({ ... })` call in a file, as source text. */
function writerCalls(src: string): string[] {
  const calls: string[] = [];
  for (let from = src.indexOf("recordActivity("); from >= 0; from = src.indexOf("recordActivity(", from + 1)) {
    calls.push(sliceCall(src, from));
  }
  return calls;
}

/**
 * The stamp, spelled exactly, in the handlers that hold the home project in a local named
 * `homeProjectId`. Conditional on purpose: a document with no project passes no `projectId` at all,
 * which is what the create and replace rows already do.
 */
const HOME_STAMP = "...(homeProjectId ? { projectId: homeProjectId } : {})";

describe("the home project reaches the writers without a second query", () => {
  it("the share-link access check reads primaryProjectId off the row it already fetches", () => {
    const src = source(LINKS_SHARED);
    expect(src).toContain(".select({ _id: 1, orgId: 1, title: 1, primaryProjectId: 1 })");
    expect(src, "DocAccess must carry the home project for both link handlers").toContain("homeProjectId: string | null;");
    expect(src).toContain('homeProjectId: doc.primaryProjectId ? String(doc.primaryProjectId) : null,');
  });

  it("the doc PATCH takes it from the pre-read it already does for the activity diff", () => {
    const src = source(DOC_ROUTE);
    // The pre-read named `before` selects the field; the stamp must not add a query of its own.
    expect(src).toMatch(/const before =[\s\S]{0,400}primaryProjectId: 1,/);
    expect(src).toMatch(/const homeProjectId =\s+before && \(before as \{ primaryProjectId\?: unknown \}\)\.primaryProjectId/);
  });

  it("the doc DELETE widens its projection by one field instead of querying again", () => {
    const src = source(DOC_ROUTE);
    expect(src).toContain(".select({ _id: 1, title: 1, primaryProjectId: 1 })");
    expect(src).toMatch(/const homeProjectId = \(deleted as \{ primaryProjectId\?: unknown \}\)\.primaryProjectId/);
  });

  it("the tag target check returns the document's home alongside the access answer", () => {
    const src = source(TAGS_ROUTE);
    expect(src).toContain("type TargetCheck = { ok: boolean; homeProjectId: string | null };");
    expect(src).toContain(".select({ _id: 1, primaryProjectId: 1 })");
    expect(src).toContain('return { ok: true, homeProjectId: doc.primaryProjectId ? String(doc.primaryProjectId) : null };');
  });
});

describe("share-link writers stamp the document's room", () => {
  const cases: Array<{ label: string; file: string; anchor: string }> = [
    { label: "share_link.created", file: LINKS_ROUTE, anchor: 'type: "share_link.created"' },
    { label: "share_link.updated", file: LINK_ROUTE, anchor: 'type: "share_link.updated"' },
    { label: "share.updated (links restored by enabling one)", file: LINK_ROUTE, anchor: 'type: "share.updated"' },
    { label: "share_link.revoked", file: LINK_ROUTE, anchor: 'type: "share_link.revoked"' },
  ];

  for (const { label, file, anchor } of cases) {
    test(`${label} passes projectId`, () => {
      expect(writerCall(source(file), anchor)).toContain(HOME_STAMP);
    });
  }

  it("both handlers take the home project off the access gate rather than querying for it", () => {
    for (const file of [LINKS_ROUTE, LINK_ROUTE]) {
      expect(source(file)).toContain("homeProjectId } = gate.access;");
    }
  });
});

describe("document writers stamp the document's room", () => {
  const cases: Array<{ label: string; anchor: string }> = [
    { label: "doc.archived / doc.unarchived", anchor: 'type: body.isArchived ? "doc.archived" : "doc.unarchived"' },
    { label: "share.updated (the document's share fields)", anchor: 'type: "share.updated"' },
    { label: "doc.deleted", anchor: 'type: "doc.deleted"' },
  ];

  for (const { label, anchor } of cases) {
    test(`${label} passes projectId`, () => {
      expect(writerCall(source(DOC_ROUTE), anchor)).toContain(HOME_STAMP);
    });
  }

  /**
   * These two were already right and are pinned so a cleanup does not sweep them into the shared
   * local: they deliberately name a project other than `homeProjectId`. The containment row names
   * the home being set in this very request, and the membership rows name the project joined or
   * left, which is the whole point of the event.
   */
  test("the containment and membership rows keep their own project, which is not the home local", () => {
    const src = source(DOC_ROUTE);
    const contained = writerCall(src, 'type: setFields.visibility === "project" ? "doc.contained" : "doc.uncontained"');
    expect(contained).toContain("projectId: String(setFields.primaryProjectId ??");
    expect(writerCall(src, "type: t.type")).toContain("projectId: t.projectId,");
  });
});

describe("tag writers stamp the room of a tagged document", () => {
  const STAMP = "projectId: targetKind === \"project\" ? targetId : (target.homeProjectId ?? undefined),";

  for (const type of ["tag.applied", "tag.removed"]) {
    test(`${type} names the project itself for a project target and the home project for a document`, () => {
      expect(writerCall(source(TAGS_ROUTE), `type: "${type}"`)).toContain(STAMP);
    });
  }

  it("a contact target still has no project, so those rows stay workspace-wide", () => {
    // `homeProjectId` is null for every kind but `doc`, so the expression above resolves to
    // undefined for a contact and the row is written with projectId null, as it always was.
    const src = source(TAGS_ROUTE);
    expect(src).toContain('case "contact":');
    expect(src).toMatch(/case "contact":[\s\S]{0,200}\{ ok: true, homeProjectId: null \}/);
  });
});

/**
 * The guard against the next forgotten writer.
 *
 * A row about a document belongs to that document's room as much as to the workspace, so any
 * `recordActivity` call in these files that names a `docId` has to say something about `projectId`
 * too. This is deliberately a text check rather than a behavioural one: it is cheap, it covers
 * writers nobody has written yet, and the failure message says exactly what is missing.
 */
describe("no document-scoped writer in these files omits projectId", () => {
  for (const file of [DOC_ROUTE, LINKS_ROUTE, LINK_ROUTE, TAGS_ROUTE]) {
    it(`${file} stamps every writer that names a document`, () => {
      const calls = writerCalls(source(file));
      expect(calls.length, `${file} should still contain recordActivity calls`).toBeGreaterThan(0);
      for (const call of calls) {
        if (!call.includes("docId")) continue;
        expect(
          call.includes("projectId"),
          `a recordActivity call in ${file} passes docId without projectId, so the document's room ` +
            `will not see the row:\n${call}`,
        ).toBe(true);
      }
    });
  }
});
