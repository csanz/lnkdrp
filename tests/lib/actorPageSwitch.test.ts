/**
 * Two things a contributor's page has to get right that only show up when you use it.
 *
 * 1. Following "Connected by <name>" off an agent's page must not leave that agent on screen. Only
 *    the success path wrote `profile`, so the previous contributor's name, tiles and chart stayed
 *    under the new URL: a flash while the request was in flight, and permanently when it failed.
 *    The page reads as "the link did nothing".
 * 2. The feed and the rail have to start on the same line. The rail's title lived inside its card,
 *    so the card's own top padding pushed "Documents" below "Yesterday".
 *
 * Neither can be mounted here: this repo has no DOM test environment (no jsdom, no happy-dom, no
 * testing library), so these are source contracts, the same shape as
 * `tests/lib/activityWorkChartShared.test.ts`. They are worth having even so, because both
 * defects are one edit away from coming back and neither is visible in a type.
 */
import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../..");
const PAGE = readFileSync(path.join(ROOT, "src/components/people/ActorPageClient.tsx"), "utf8");
const ROWS = readFileSync(path.join(ROOT, "src/components/activity/ActivityRows.tsx"), "utf8");

/** The body of the effect that reloads when `actorKey` changes. */
function actorEffect(): string {
  const end = PAGE.indexOf("}, [actorKey]);");
  expect(end).toBeGreaterThan(-1);
  const start = PAGE.lastIndexOf("useEffect(() => {", end);
  expect(start).toBeGreaterThan(-1);
  return PAGE.slice(start, end);
}

describe("switching from one contributor to another", () => {
  it("drops the previous contributor's profile before loading the next", () => {
    const body = actorEffect();
    expect(body).toContain("setProfile(null)");
    // Before the request goes out, not after it answers: the point is that nothing of the previous
    // contributor survives into the new page.
    expect(body.indexOf("setProfile(null)")).toBeLessThan(body.indexOf("fetchWithTempUser"));
  });

  it("clears the chart with it, so the graph cannot belong to the previous contributor", () => {
    expect(actorEffect()).toContain("setSummary(null)");
  });

  it("reloads on the actor, not once on mount", () => {
    expect(PAGE).toContain("}, [actorKey]);");
  });
});

describe("the two columns line up", () => {
  it("the rail's title is the feed's heading component, outside the card", () => {
    const start = PAGE.indexOf("function RailCard(");
    expect(start).toBeGreaterThan(-1);
    const card = PAGE.slice(start, start + 800);
    expect(card).toContain("<ColumnHeading>{title}</ColumnHeading>");
    // The heading must come before the panel that holds the rows, or it is inside it again.
    expect(card.indexOf("<ColumnHeading>")).toBeLessThan(card.indexOf("rounded-xl border"));
  });

  it("the feed's day heading is the same component, so neither can drift", () => {
    expect(ROWS).toContain("export function ColumnHeading(");
    const dayHeading = ROWS.slice(ROWS.indexOf("export function DayHeading("), ROWS.indexOf("export function ColumnHeading("));
    expect(dayHeading).toContain("<ColumnHeading>{children}</ColumnHeading>");
  });

  it("only one place decides the heading's spacing", () => {
    // `mb-2 px-1` is the offset that puts a heading above a column of cards. Two copies is how the
    // columns fell out of step in the first place.
    const copies = ROWS.split("mb-2 px-1").length - 1 + (PAGE.split("mb-2 px-1").length - 1);
    expect(copies).toBe(1);
  });
});
