/**
 * A document created into a project is in the room from its first write, and the room rides on
 * every event that follows (docs/prds/lnkdrp-project-home.md, decisions 1 and 2).
 *
 * Source contracts, because the two routes are large and mocked end to end elsewhere: what is
 * pinned is that the creation route resolves the project before writing, refuses a request inbox,
 * writes the membership and the primary pointer together, and that the process route carries the
 * home project on the feed row and the Slack post.
 */
import { readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";

const create = readFileSync("src/app/api/docs/route.ts", "utf8");
const process = readFileSync("src/app/api/uploads/[uploadId]/process/route.ts", "utf8");
const doc = readFileSync("src/lib/models/Doc.ts", "utf8");

describe("POST /api/docs { projectId }", () => {
  test("the project is checked in the caller's workspace, alive, and not a request inbox, before any write", () => {
    // The read is now multi-line because it also carries the locked-room visibility clause
    // (docs/prds/lnkdrp-locked-projects.md, decision 27): a room the caller is not in is not a room
    // they can create into, and the refusal stays the PROJECT_NOT_FOUND asserted below.
    expect(create).toMatch(
      /ProjectModel\.findOne\(\{\s+_id: new Types\.ObjectId\(pid\),\s+orgId: new Types\.ObjectId\(actor\.orgId\),\s+isDeleted: \{ \$ne: true \},\s+\$and: \[projectVisibilityClause\(await projectGrantIds\(actor\.orgId, actor\.userId, request\)\)\],\s+\}\)/,
    );
    expect(create).toContain('code: "PROJECT_NOT_FOUND"');
    expect(create).toContain('code: "PROJECT_IS_INBOX"');
    expect(create.indexOf('code: "PROJECT_IS_INBOX"')).toBeLessThan(create.indexOf("await DocModel.create({"));
  });

  test("membership and the primary pointer are written together, in the create", () => {
    expect(create).toContain("projectIds: [homeProject._id], primaryProjectId: homeProject._id, projectId: homeProject._id, visibility");
  });

  test("containment needs a home", () => {
    expect(create).toContain('code: "VISIBILITY_NEEDS_PROJECT"');
    expect(doc).toMatch(/visibility: \{ type: String, enum: \["workspace", "project"\], default: "workspace"/);
  });

  test("the created row names the room", () => {
    expect(create).toMatch(/type: "doc\.created",[\s\S]{0,300}projectId: String\(homeProject\._id\), meta: \{ projectName: homeProject\.name/);
  });
});

describe("the process route", () => {
  test("reads the primary project and puts it on the processed row and the Slack post", () => {
    expect(process).toMatch(/primaryProjectId: 1,/);
    expect(process).toMatch(/\.\.\.\(homeProjectId \? \{ projectId: homeProjectId \} : \{\}\),\s+meta: \{\s+\.\.\.\(homeProjectName \? \{ projectName: homeProjectName \} : \{\}\),/);
    expect(process).toContain('change: "created", projectId: homeProjectId');
  });
});
