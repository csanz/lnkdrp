/**
 * You can make your first tag.
 *
 * The three facts together were a closed loop:
 *
 *   1. `TagsManager` is the only thing that can create a tag nothing carries yet.
 *   2. It is rendered on exactly one screen, `/tags`.
 *   3. The only link to `/tags` is the gear inside the sidebar's Tags section.
 *
 * ...and that section returned `null` while the workspace had no tags. So the door to making a
 * first tag was inside a room that did not exist until you had already been in it. A new workspace
 * could not create one from the UI at all — only through MCP or the API, which is how the gap was
 * found.
 *
 * Nothing here renders React (these suites run in `node`), so this reads the source for the two
 * properties that closed the loop. Blunt, but it fails if somebody restores the early return as a
 * tidy-up, which is the realistic way this regresses.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, test } from "vitest";

const ROOT = join(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

const SECTION = "src/components/SidebarTagsSection.tsx";

describe("the sidebar section survives an empty workspace", () => {
  test("it does not bail out just because the list is empty", () => {
    const src = read(SECTION);

    // The exact shape that caused it. `if (!tags) return null` is still correct — that is "not
    // loaded yet", not "none" — so the assertion has to be about the length check specifically.
    expect(src).not.toContain("if (!tags || !tags.length) return null");
    expect(src).not.toMatch(/if\s*\(\s*!tags\?*\.?length\s*\)\s*return null/);
    expect(src).toContain("if (!tags) return null");
  });

  test("an empty list still says so, and offers the way out of it", () => {
    const src = read(SECTION);

    expect(src).toContain("No tags yet.");
    // The link matters more than the words: it is the only route to the only screen that can
    // create one.
    expect(src).toContain('href="/tags"');
  });

  test("the header still renders the manage link, which is that route", () => {
    expect(read(SECTION)).toContain('aria-label="Manage tags"');
  });
});

describe("the rest of the loop is still where it was", () => {
  test("/tags is what renders the manager", () => {
    expect(read("src/app/(app)/tags/pageClient.tsx")).toContain("<TagsManager />");
  });

  test("the manager is what creates a tag nothing carries", () => {
    const src = read("src/components/tags/TagsManager.tsx");

    expect(src).toContain('"/api/tags"');
    expect(src).toContain('method: "POST"');
  });
});
