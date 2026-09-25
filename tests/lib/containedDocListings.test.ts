/**
 * Contained documents (docs/prds/lnkdrp-project-home.md, decision 4): a document with
 * `visibility: "project"` is absent from every workspace-wide listing and present in its project's
 * own listings.
 *
 * This is a source contract, not a behaviour test: each workspace-wide listing has to spread
 * `workspaceListableDocFilter()` from `@/lib/docs/visibility` into its Mongo filter, and the
 * dashboard's `$lookup` into `docs` (which is `$expr`-based) has to carry the equivalent
 * `{ $ne: ["$visibility", "project"] }` clause. A listing that drops the rule fails here, so the
 * rule cannot quietly disappear in a refactor. The project-scoped listings must NOT use it, or a
 * contained document would vanish from the one place it is supposed to live.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const IMPORT_RX = /import\s*\{[^}]*\bworkspaceListableDocFilter\b[^}]*\}\s*from\s*["']@\/lib\/docs\/visibility["']/;

function source(rel: string): string {
  return readFileSync(path.join(ROOT, rel), "utf8");
}

/** Every workspace-wide document listing, keyed by what it lists. */
const WORKSPACE_LISTINGS: Array<{ label: string; file: string }> = [
  { label: "GET /api/docs (list and search)", file: "src/app/api/docs/route.ts" },
  { label: "GET /api/sidebar (recent docs)", file: "src/app/api/sidebar/route.ts" },
  { label: "GET /api/tags/:tag/docs (AI tag docs)", file: "src/app/api/tags/[tag]/docs/route.ts" },
  { label: "GET /api/tags/by-slug/:slug/items (workspace tag items)", file: "src/app/api/tags/by-slug/[slug]/items/route.ts" },
  { label: "tag service live-assignment counts", file: "src/lib/tags/service.ts" },
  { label: "GET /api/starred", file: "src/app/api/starred/route.ts" },
  { label: "POST /api/starred/bootstrap", file: "src/app/api/starred/bootstrap/route.ts" },
  { label: "GET /api/changes (workspace history)", file: "src/app/api/changes/route.ts" },
  { label: "GET /api/dashboard/stats (active docs)", file: "src/app/api/dashboard/stats/route.ts" },
  { label: "workspace metrics query", file: "src/lib/analytics/workspace/query.ts" },
  { label: "GET /api/projects/:slug/suggested-docs (workspace docs not yet in the project)", file: "src/app/api/projects/[projectSlug]/suggested-docs/route.ts" },
];

/** The project's own listings: a contained document must still show up here. */
const PROJECT_LISTINGS: Array<{ label: string; file: string }> = [
  { label: "GET /api/projects/:slug/docs", file: "src/app/api/projects/[projectSlug]/docs/route.ts" },
  { label: "public project page", file: "src/lib/share/projectPublic.ts" },
];

describe("contained documents: workspace-wide listings", () => {
  it("the helper itself excludes only visibility: project", async () => {
    const { workspaceListableDocFilter, WORKSPACE_LISTABLE_MATCH } = await import("@/lib/docs/visibility");
    expect(workspaceListableDocFilter()).toEqual({ visibility: { $ne: "project" } });
    expect(WORKSPACE_LISTABLE_MATCH).toEqual({ visibility: { $ne: "project" } });
  });

  for (const { label, file } of WORKSPACE_LISTINGS) {
    it(`${label} imports workspaceListableDocFilter from @/lib/docs/visibility`, () => {
      const src = source(file);
      expect(src, `${file} must import workspaceListableDocFilter`).toMatch(IMPORT_RX);
      // A bare spread in most listings; the tag service spreads it conditionally (doc lookup only).
      expect(src, `${file} must spread workspaceListableDocFilter() into its filter`).toMatch(/workspaceListableDocFilter\(\)/);
    });
  }

  it("the dashboard ShareView $lookup into docs drops contained documents beside deleted ones", () => {
    const src = source("src/app/api/dashboard/stats/route.ts");
    expect(src).toContain('{ $ne: ["$isDeleted", true] }');
    expect(src).toContain('{ $ne: ["$visibility", "project"] }');
  });
});

describe("contained documents: project-scoped listings", () => {
  for (const { label, file } of PROJECT_LISTINGS) {
    it(`${label} does not use the workspace-wide filter`, () => {
      const src = source(file);
      expect(src, `${file} must not import workspaceListableDocFilter`).not.toMatch(IMPORT_RX);
      expect(src).not.toContain("workspaceListableDocFilter");
      expect(src).not.toContain("WORKSPACE_LISTABLE_MATCH");
    });
  }
});
