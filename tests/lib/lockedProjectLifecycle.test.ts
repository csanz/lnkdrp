/**
 * Everything that has to happen to a grant when something else ends
 * (docs/prds/lnkdrp-locked-projects.md, decisions 4, 17, 18 and 32).
 *
 * A grant into a private data room outlives the thing that justified it unless four separate files
 * remember to clear it: the workspace-membership revoke route, `.../leave`, the account purge and the
 * workspace-delete sweep. Nothing in the type system can see a file that forgot, and the failure is
 * silent and serious in both directions: a removed colleague who keeps reading the room, or a
 * re-invited one whose rooms come back with them because `org-invites/claim` revives a revoked
 * `OrgMembership` on purpose.
 *
 * So this is a source contract, in the idiom of `tests/lib/lockedProjectSurfaces.test.ts`: the grep
 * IS the mechanism. It also pins the two things a lock makes unrecoverable if they are left as they
 * are — the hard `DELETE` that stranded a contained document with no home, and the realtime watcher
 * that broadcasts every project's name to every socket in the workspace.
 */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, test } from "vitest";

const ROOT = path.resolve(__dirname, "../..");

function read(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** The one writer that clears grants, and the file that owns it. */
const LOCK_SCOPE = "src/lib/projects/lockScope.ts";

/**
 * The four chase sites, and how each one clears grants.
 *
 * Three of them clear (soft: `isDeleted` and `revokedAt` together, so "who has ever been in this
 * room" stays answerable) and therefore import `revokeProjectGrants`. The purge REMOVES instead, and
 * that is not an exception to the rule so much as the one caller whose job is to forget: `revokedAt`
 * exists so a room can say who used to be in it, which is exactly the record an account deletion must
 * not keep. It is still pinned here, because a purge that stopped clearing grants at all is the same
 * bug as a revoke that never did.
 */
const CHASE_SITES: Array<{ file: string; how: "revoke" | "delete"; why: string }> = [
  {
    file: "src/app/api/orgs/[orgId]/members/[userId]/revoke/route.ts",
    how: "revoke",
    why: "removing somebody from the workspace takes their rooms with them, in the same request",
  },
  {
    file: "src/app/api/orgs/[orgId]/leave/route.ts",
    how: "revoke",
    why: "leaving does the same thing to yourself",
  },
  {
    file: "src/app/api/orgs/[orgId]/route.ts",
    how: "revoke",
    why: "the workspace-delete sweep is a SOFT delete, so a grant left live here would be live again if the workspace were restored",
  },
  {
    file: "src/lib/accounts/purge.ts",
    how: "delete",
    why: "a purge forgets rather than records, and it must reach grants in workspaces that survive as well as the ones it deletes",
  },
];

describe("a grant never outlives the membership that justified it", () => {
  test.each(CHASE_SITES)("$file clears grants ($why)", ({ file, how }) => {
    const src = read(file);
    if (how === "revoke") {
      expect(src, `${file} must import revokeProjectGrants from ${LOCK_SCOPE}`).toMatch(
        /import\s*\{[^}]*\brevokeProjectGrants\b[^}]*\}\s*from\s*["']@\/lib\/projects\/lockScope["']/,
      );
      expect(src).toMatch(/await revokeProjectGrants\(/);
    } else {
      expect(src).toContain("ProjectMembershipModel.deleteMany(");
      // The one that is easy to lose: an account that was only ever a member of somebody else's
      // workspace skips every block gated on owning one alone.
      expect(src, "the purge must reach grants in workspaces that are NOT being deleted").toContain(
        "ProjectMembershipModel.deleteMany({ userId: id })",
      );
    }
  });

  it("clears isDeleted and revokedAt together, or nothing can say when access ended", () => {
    const src = read(LOCK_SCOPE);
    expect(src).toMatch(/\$set:\s*\{[^}]*isDeleted:\s*true,\s*revokedAt:\s*now[^}]*\}/);
  });

  it("nothing outside lockScope.ts and the purge writes to the grant collection", () => {
    // Four call sites became one exported function precisely so a fifth cannot appear quietly. The
    // create route is allowed its `create` (it seats the room's first member inside the create it is
    // part of); everything else goes through the writers in lockScope.ts.
    const allowed = new Set([LOCK_SCOPE, "src/lib/accounts/purge.ts", "src/app/api/projects/route.ts"]);
    const WRITE_RX = /ProjectMembershipModel\.(updateOne|updateMany|deleteOne|deleteMany|create|insertMany|bulkWrite|findOneAndUpdate)\s*\(/;
    const offenders = sourceFiles()
      .filter((f) => !allowed.has(f))
      .filter((f) => WRITE_RX.test(read(f)));
    expect(
      offenders,
      [
        "These files write grants directly. Use the writers in src/lib/projects/lockScope.ts:",
        "grantProjectMembership to seat somebody, revokeProjectGrants to clear, deleteProjectGrants",
        "for a room whose row is hard-deleted.",
        ...offenders,
      ].join("\n"),
    ).toEqual([]);
  });

  it("org-invites/claim never touches a grant, so a re-invited person comes back with no rooms", () => {
    const src = read("src/app/api/org-invites/claim/route.ts");
    expect(src).not.toContain("ProjectMembership");
    expect(src).not.toContain("lockScope");
  });
});

describe("deleting a room does not strand its documents (decision 32)", () => {
  const src = read("src/app/api/projects/[projectSlug]/route.ts");

  it("clears Doc.visibility for a document that has just lost its home", () => {
    // `visibility: "project"` means "listed only inside its data room". A hard project delete never
    // cleared it, so the document disappeared from every workspace listing AND from every project
    // while `/p/:shareId` kept serving it: an unrecoverable publisher.
    expect(src).toMatch(/visibility:\s*"project"/);
    expect(src).toMatch(/\$set:\s*\{\s*visibility:\s*"workspace"\s*\}/);
  });

  it("removes the room's grants, after the row itself", () => {
    expect(src).toMatch(/import\s*\{[^}]*\bdeleteProjectGrants\b[^}]*\}\s*from\s*["']@\/lib\/projects\/lockScope["']/);
    const deleteRow = src.indexOf("await ProjectModel.deleteOne({ _id: projectId");
    const deleteGrants = src.indexOf("await deleteProjectGrants(");
    expect(deleteRow).toBeGreaterThan(0);
    // The other order destroys the member list that says who to ask while the room is still there.
    expect(deleteGrants).toBeGreaterThan(deleteRow);
  });

  it("clears the documents before it deletes the row, so a crash is resumable", () => {
    const docFix = src.indexOf('$set: { visibility: "workspace" }');
    const deleteRow = src.indexOf("await ProjectModel.deleteOne({ _id: projectId");
    expect(docFix).toBeGreaterThan(0);
    expect(deleteRow).toBeGreaterThan(docFix);
  });
});

describe("the realtime projects watcher stops broadcasting a locked room's name", () => {
  const src = read("realtime/server.ts");

  it("projects visibility, so the handler can see what it is about to send", () => {
    expect(src).toContain('"fullDocument.visibility": 1');
  });

  it("skips the frame for a locked row", () => {
    expect(src).toMatch(/if \(doc\?\.visibility === "locked"\) return;/);
  });

  it("tests for locked rather than for not-workspace", () => {
    // Every project row that predates this feature carries no `visibility` field at all, so treating
    // "absent" as locked would silence this watcher for the entire product.
    expect(src).not.toContain('doc?.visibility !== "workspace"');
  });
});

describe("the lock's own feed rows land where the people who lost the room can read them", () => {
  it("project.locked and project.unlocked are written with projectId: null (decision 17)", () => {
    const src = read("src/app/api/projects/[projectSlug]/route.ts");
    const idx = src.indexOf('type: lockWrite.target === "locked" ? "project.locked" : "project.unlocked"');
    expect(idx).toBeGreaterThan(0);
    // A room that vanishes from ten sidebars with no explanation is a support ticket, and its name was
    // already public to those ten people.
    expect(src.slice(idx, idx + 400)).toContain("projectId: null");
    expect(src.slice(idx, idx + 400)).toContain("projectName");
  });

  it("the four types exist, and the member rows are filed with the projects", async () => {
    const { ACTIVITY_FILTERS } = await import("@/lib/activity/labels");
    const projects = ACTIVITY_FILTERS.find((f) => f.id === "projects")!.types as readonly string[];
    for (const t of ["project.locked", "project.unlocked", "project.member_added", "project.member_removed"]) {
      expect(projects).toContain(t);
    }
  });

  it("each one renders a sentence rather than falling through to a bare type", async () => {
    const { describeActivity } = await import("@/lib/activity/labels");
    const base = {
      id: "1",
      createdDate: new Date().toISOString(),
      actor: { name: "Chris" },
      project: { id: "p1", name: "Acme raise" },
    } as unknown as Parameters<typeof describeActivity>[0];
    const locked = describeActivity({ ...base, type: "project.locked", meta: { projectName: "Acme raise" } });
    expect(`${locked.verb} ${locked.object}`).toMatch(/made Acme raise/);
    const added = describeActivity({
      ...base,
      type: "project.member_added",
      meta: { name: "Dana", projectName: "Acme raise" },
    });
    expect(`${added.verb} ${added.object} ${added.suffix ?? ""}`).toMatch(/added Dana to Acme raise/);
  });
});

describe("the named refusals are one string each", () => {
  it("LOCK_NOT_SUPPORTED_ON_REQUEST lives in one file and both callers use it", () => {
    const refusals = read("src/lib/projects/lockRefusals.ts");
    expect(refusals).toContain('export const LOCK_NOT_SUPPORTED_ON_REQUEST = "LOCK_NOT_SUPPORTED_ON_REQUEST"');
    for (const file of [
      "src/app/api/projects/[projectSlug]/route.ts",
      "src/app/api/projects/[projectSlug]/lock-review/route.ts",
    ]) {
      expect(read(file)).toContain("lockNotSupportedOnRequestResponse");
    }
  });

  it("the write refuses an API key on the lock, and only on the lock", () => {
    const src = read("src/app/api/projects/[projectSlug]/route.ts");
    const idx = src.indexOf("if (visibilityTarget) {");
    expect(idx).toBeGreaterThan(0);
    // Refusing the whole route would break a rename over MCP, which is document work an agent is
    // meant to do.
    expect(src.slice(idx, idx + 800)).toContain("forbidApiKey(actor,");
  });
});

/** Every `.ts`/`.tsx` file under `src/`, relative to the repo root with forward slashes. */
function sourceFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(entry.name)) out.push(path.relative(ROOT, p).split(path.sep).join("/"));
    }
  };
  walk(path.join(ROOT, "src"));
  return out;
}
