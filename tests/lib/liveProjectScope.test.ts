/**
 * Deleting a project has to actually delete it.
 *
 * The same twelve-line `$or` — "this project id, in my workspace, or a legacy one of mine" — was
 * pasted into five routes, and exactly one of them, the link gate in
 * `src/app/api/projects/[projectSlug]/links/shared.ts`, remembered to exclude deleted rows. So a
 * project in the trash could still be renamed, re-described, given a new introduction and
 * re-published by `PATCH /api/projects/:id`, and it still answered `GET .../docs` and
 * `.../suggested-docs`.
 *
 * The user-facing delete is a hard one, so the door here is narrow: `Project.isDeleted` is written
 * only by the two admin data routes and the org-delete sweep. It is also the door an owner cannot
 * see through — an admin retires a project and the owner carries on renaming and re-publishing it,
 * writing activity rows the whole time.
 *
 * Two things are pinned here, because the bug had two halves:
 *
 * 1. **The rule itself** — including the `$or` nesting, which is where a hand-rolled copy goes
 *    wrong silently. In a JS object literal a second `$or` key *replaces* the first, so a match
 *    written as `{ $or: [...], isDeleted: ..., $or: [...] }` runs with fewer bounds than it reads
 *    as having, and a query with fewer bounds returns more rows, confidently. The legacy branch
 *    therefore keeps `isDeleted` as a sibling of one `$or`, never as a second one.
 * 2. **That the routes still call it.** The bug was not a wrong filter, it was five copies of a
 *    right one drifting apart. A sixth copy pasted back in would pass every behavioural test in
 *    this repo, so the source check below is the part that actually holds the line.
 */
import fs from "node:fs";
import path from "node:path";

import { Types } from "mongoose";
import { describe, expect, test } from "vitest";

import { liveProjectByIdMatch, liveProjectFilter } from "@/lib/projects/scope";

const PROJECT_ID = new Types.ObjectId("64b0c0ffee0000000000e001");
const ORG_ID = new Types.ObjectId("64b0c0ffee0000000000e002");
const USER_ID = new Types.ObjectId("64b0c0ffee0000000000e003");

const REPO_ROOT = path.resolve(__dirname, "../..");

/** The routes that look a project up by id and may act on it. */
const PROJECT_BY_ID_ROUTES = [
  "src/app/api/projects/[projectSlug]/route.ts",
  "src/app/api/projects/[projectSlug]/docs/route.ts",
  "src/app/api/projects/[projectSlug]/suggested-docs/route.ts",
  "src/app/api/projects/[projectSlug]/links/shared.ts",
];

describe("liveProjectByIdMatch", () => {
  test("a workspace project is bounded by workspace and by deletion, together", () => {
    expect(liveProjectByIdMatch(PROJECT_ID, ORG_ID, USER_ID, false)).toEqual({
      _id: PROJECT_ID,
      orgId: ORG_ID,
      isDeleted: { $ne: true },
    });
  });

  test("the legacy branch keeps `isDeleted` beside the `$or`, not as a second one", () => {
    const match = liveProjectByIdMatch(PROJECT_ID, ORG_ID, USER_ID, true);

    // The whole point: exactly one top-level `$or`, and the deletion bound outside it so it applies
    // to both alternatives rather than to whichever branch happened to be written last.
    expect(Object.keys(match).sort()).toEqual(["$or", "isDeleted"]);
    expect(match.isDeleted).toEqual({ $ne: true });
    expect(match.$or).toEqual([
      { _id: PROJECT_ID, orgId: ORG_ID },
      { _id: PROJECT_ID, userId: USER_ID, $or: [{ orgId: { $exists: false } }, { orgId: null }] },
    ]);
  });

  test("a legacy project resolves only from the person's own workspace", () => {
    // `allowLegacyByUserId` is the caller's answer to "is the actor in their personal workspace",
    // so with it false there is no by-userId alternative at all — a team workspace must not surface
    // the caller's own pre-workspace projects.
    expect(JSON.stringify(liveProjectByIdMatch(PROJECT_ID, ORG_ID, USER_ID, false))).not.toContain("userId");
  });

  test("it agrees with the list filter about what deleted means", () => {
    // If these two ever disagree, a project is actionable but invisible, or visible but refused.
    expect(liveProjectByIdMatch(PROJECT_ID, ORG_ID, USER_ID, false).isDeleted).toEqual(
      liveProjectFilter(ORG_ID).isDeleted,
    );
  });
});

/** The lists a project can be reached from. All three must hide what the routes refuse. */
const PROJECT_LIST_ROUTES = [
  "src/app/api/projects/route.ts",
  "src/app/api/sidebar/route.ts",
  "src/app/api/requests/route.ts",
];

describe("the lists a project is reached from", () => {
  test.each(PROJECT_LIST_ROUTES)("%s hides what the by-id routes refuse", (relative) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
    // Bounding the by-id routes without bounding the lists trades one bug for a worse one: the
    // sidebar kept listing admin-retired projects, every click landed on "Project not found.", and
    // the page's own prune (`refreshSidebarCache`) refetched the same row. Delete was a dead end
    // too — the DELETE 404s, so the row could not be cleared from the UI at all.
    expect(source).toMatch(/isDeleted: \{ \$ne: true \}/);
  });
});

describe("the routes that act on a project by id", () => {
  test.each(PROJECT_BY_ID_ROUTES)("%s builds its match with the shared rule", (relative) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
    expect(source).toContain("liveProjectByIdMatch");
  });

  test.each(PROJECT_BY_ID_ROUTES)("%s does not hand-roll the match again", (relative) => {
    const source = fs.readFileSync(path.join(REPO_ROOT, relative), "utf8");
    // The shape of every one of the five copies: a project lookup whose filter is an inline
    // `allowLegacyByUserId ? … : …`. Nothing else in these files matches it.
    expect(source).not.toMatch(/ProjectModel\.findOne\(\s*\n\s*allowLegacyByUserId/);
  });
});
