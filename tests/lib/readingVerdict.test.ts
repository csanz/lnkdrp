/**
 * Two-slot verdict (spec §3.6) on the hand-built fixtures.
 */
import { describe, expect, test } from "vitest";

import { buildPersonResponse, buildReadingResponse, buildVerdict } from "@/lib/analytics/reading";

import {
  BACKWARDS,
  DOWNLOADER,
  EVEN_TYPICAL,
  F1,
  F11,
  F12,
  F2,
  F3,
  F5,
  F6,
  F7,
  F8,
  HOUR,
  INTENSE,
  ISAAC,
  JUMPER_LONG,
  LAST_PAGE_PASSED,
  MAYA,
  NADIA,
  NADIA_STANDOUT,
  PRIYA,
  SAMUEL,
  SK1,
  coreOf,
  docOf,
  fixture,
  personOf,
  type EventSpec,
  type Fixture,
} from "./fixtures/readingFixtures";

const NBSP = "\u00a0";
/** Expected copy with the no-break space the verdict puts between "page(s)" and its number. */
const nb = (s: string) => s.replace(/\b(pages?) (\d)/g, `$1${NBSP}$2`);

const text = (fx: Fixture) => buildVerdict(personOf(fx), fx.P).text;

function personResponse(fx: Fixture, doc?: ReturnType<typeof docOf>, tz = "UTC") {
  const core = coreOf(fx, doc ? { doc } : {});
  const person = core.people.find((p) => p.key === fx.keys[0])!;
  return { core, r: buildPersonResponse(core, person, { days: 30, now: fx.now, tz }) };
}

describe("buildVerdict", () => {
  test.each([
    ["F1", F1, "Went through all 4 pages. Went back to page 3."],
    ["F2", F2, "Stopped at page 3 of 5. Spent 25s on page 3, then left."],
    // Page 3 was on screen, then back on page 2 where they left.
    ["F3", F3, "Got as far as page 3 of 4 and left on page 2. Went back to page 2."],
    ["F5", F5, "Left on page 1."],
    ["F6", F6, "Reached the last page, skipping pages 3–4. Came back 3 days later."],
    ["F7", F7, "Stopped at page 2 of 4."],
    ["F8", F8, "Read all 3 pages."],
    ["F11", F11, "Read the only page."],
    ["F12", F12, "Went through all 3 pages. Passed over page 2 quickly."],
    ["SK1", SK1, "Went through all 10 pages. Passed over pages 1–9 quickly."],
    ["Nadia", NADIA, "Went through all 12 pages."],
    ["Maya", MAYA, "Stopped at page 2 of 12."],
    ["Isaac", ISAAC, "Jumped to page 10 of 13, skipping pages 2–9. Spent 57s on page 10, then left."],
    ["Intense", INTENSE, `Stopped at page 2 of 12. Spent 1m${NBSP}10s on page 2, then left.`],
  ])("%s", (_name, fx, expected) => {
    expect(text(fx)).toBe(nb(expected));
  });

  test("slots", () => {
    expect(buildVerdict(personOf(F1), 4)).toEqual({
      coverage: "Went through all 4 pages",
      behaviour: nb("Went back to page 3"),
      text: nb("Went through all 4 pages. Went back to page 3."),
      page: 3,
    });
    expect(buildVerdict(personOf(F7), 4)).toMatchObject({ behaviour: null, page: null });
    expect(buildVerdict(personOf(F2), 5).page).toBe(3);
    expect(buildVerdict(personOf(F6), 6).page).toBeNull();
    expect(buildVerdict(personOf(F12), 3).page).toBeNull();
  });

  test("no detail", () => {
    const p = { ...personOf(F1), hasDetail: false };
    expect(buildVerdict(p, 4)).toEqual({ coverage: null, behaviour: null, text: "No page detail was recorded for this person.", page: null });
  });

  test("labels follow the page in parentheses", () => {
    expect(buildVerdict(personOf(F2), 5, (p) => (p === 3 ? "Pricing" : null)).text).toBe(nb("Stopped at page 3 of 5. Spent 25s on page 3 (Pricing), then left."));
    expect(buildVerdict(personOf(F3), 4, (p) => (p === 2 ? "Team" : null)).behaviour).toBe(nb("Went back to page 2 (Team)"));
  });

  test("longest page that is not the exit keeps the parenthesised form, without wrapping", () => {
    const fx = fixture(3, [{ name: "mid", visits: [{ events: [[1, 3000, "turn"], [2, 70000, "turn"], [3, 4000, "pagehide"]] }] }]);
    expect(text(fx)).toBe(nb(`Went through all 3 pages. Spent longest on page 2 (1m${NBSP}10s).`));
    expect(buildVerdict(personOf(fx), 3, (p) => (p === 2 ? "Team" : null)).behaviour).toBe(nb(`Spent longest on page 2 (Team), 1m${NBSP}10s`));
  });

  test("jump coverage: one page, two runs, more than two runs, and short of the last page", () => {
    const seenOnly = (P: number, seen: number[]) =>
      fixture(P, [{ name: `jump${P}-${seen.join("-")}`, visits: [{ events: [[seen[seen.length - 1], 3000, "pagehide"]], seen }] }]);
    expect(buildVerdict(personOf(seenOnly(5, [1, 3])), 5).coverage).toBe(nb("Jumped to page 3 of 5, skipping page 2"));
    expect(buildVerdict(personOf(seenOnly(10, [1, 2, 6, 10])), 10).coverage).toBe(nb("Reached the last page, skipping pages 3–5 and 7–9"));
    expect(buildVerdict(personOf(seenOnly(10, [1, 3, 5, 7, 10])), 10).coverage).toBe("Reached the last page, skipping 5 of 10 pages");
    expect(buildVerdict(personOf(seenOnly(12, [1, 2, 5, 9])), 12).coverage).toBe(nb("Jumped to page 9 of 12, skipping pages 3–4 and 6–8"));
  });

  test("came back: calendar days in the given time zone", () => {
    const LA = "America/Los_Angeles";
    const returner = (from: string, hours: number) =>
      fixture(3, [
        {
          name: `ret-${from}-${hours}`,
          visits: [
            { start: Date.parse(from), events: [[1, 3000, "pagehide"]] },
            { start: Date.parse(from) + 3000 + hours * HOUR, events: [[2, 3000, "pagehide"]] },
          ],
        },
      ]);
    // 08:00 Sep 10 → 23:00 Sep 11 in Los Angeles; the same instants are two UTC days apart.
    const nextDay = personOf(returner("2026-09-10T15:00:00.000Z", 39));
    expect(buildVerdict(nextDay, 3, undefined, { tz: LA }).behaviour).toBe("Came back the next day");
    expect(buildVerdict(nextDay, 3, undefined, { tz: "UTC" }).behaviour).toBe("Came back 2 days later");
    expect(buildVerdict(personOf(returner("2026-08-28T10:09:00.000Z", 67.6)), 3, undefined, { tz: LA }).behaviour).toBe("Came back 2 days later");
    expect(buildVerdict(personOf(returner("2026-09-10T15:00:00.000Z", 14)), 3, undefined, { tz: LA }).text).toBe(nb("Stopped at page 2 of 3. Came back 14 hours later."));
  });

  test("standout page against the page table's typical time: no ratio below five people who stayed", () => {
    const { r } = personResponse(NADIA_STANDOUT);
    // Page 7: 34s against a typical 10s from four people (Nadia included), so no ratio is stated.
    // Page 10: 42s against 30s is under twice the typical time.
    expect(r.verdict).toEqual({
      coverage: "Went through all 12 pages",
      behaviour: nb("Spent 34s on page 7"),
      text: nb("Went through all 12 pages. Spent 34s on page 7."),
      page: 7,
    });
    expect([r.pages[6].typicalMs, r.pages[9].typicalMs]).toEqual([10000, 30000]);
    expect(buildVerdict(personOf(NADIA_STANDOUT), 12).behaviour).toBe(nb("Spent longest on page 10 (42s)"));
  });

  test("the verdict ratio on an even-count page uses the inclusive median, the same as the page table", () => {
    const { core, r } = personResponse(EVEN_TYPICAL);
    const table = buildReadingResponse(core, { tier: "deep", days: 30, daysLimit: null, shareId: null, matrixLimit: 25, now: EVEN_TYPICAL.now }).pages!;
    expect(table[1]).toMatchObject({ readCount: 6, typicalMs: 16000 });
    expect(r.pages[1]).toMatchObject({ typicalMs: 16000, readCount: 6, ratio: 3.7 });
    expect(r.verdict.behaviour).toBe(nb("Spent 1m on page 2, 3.7× the typical time"));
    expect(r.pages.map((p) => p.typicalMs)).toEqual(table.map((p) => p.typicalMs));
  });

  test("standout page against page typicals for a jumper who read backwards", () => {
    const v = buildVerdict(personOf(JUMPER_LONG), 13, (p) => (p === 9 ? "Team" : null), { typicalFor: () => ({ typicalMs: 7000, readCount: 5 }) });
    expect(v.text).toBe(nb(`Went to pages 6, 9 and 8 out of order and left on page 8. Spent 1m${NBSP}44s on page 9 (Team), 14.8× the typical time.`));
    expect(v.page).toBe(9);
    const few = buildVerdict(personOf(JUMPER_LONG), 13, undefined, { typicalFor: () => ({ typicalMs: 7000, readCount: 4 }) });
    expect(few.behaviour).toBe(nb(`Spent 1m${NBSP}44s on page 9`));
  });

  test("a near tie for the longest page names no page", () => {
    expect(buildVerdict(personOf(PRIYA), 13)).toEqual({ coverage: "Read all 13 pages", behaviour: null, text: "Read all 13 pages.", page: null });
    expect(buildVerdict(personOf(PRIYA), 13, undefined, { typicalFor: () => ({ typicalMs: 40000, readCount: 9 }) }).behaviour).toBeNull();
  });

  test("P=1 without enough time went through the only page", () => {
    const fx = fixture(1, [{ name: "short", visits: [{ events: [[1, 5000, "pagehide"]] }] }]);
    expect(text(fx)).toBe("Went through the only page.");
  });

  test("longest run of passed pages wins, earliest on ties", () => {
    const fx = fixture(8, [
      {
        name: "runs",
        visits: [{ events: [[1, 5000, "turn"], [2, 500, "turn"], [3, 5000, "turn"], [4, 500, "turn"], [5, 500, "turn"], [6, 5000, "turn"], [7, 500, "turn"], [8, 5000, "pagehide"]] }],
      },
    ]);
    expect(buildVerdict(personOf(fx), 8).behaviour).toBe(nb("Passed over pages 4–5 quickly"));
  });
});

describe("verdict shapes found live", () => {
  test("Samuel: a return and a 21× page are both said; page 1 summed over two visits is no standout", () => {
    const { r } = personResponse(SAMUEL, docOf(13, { 9: "pricing" }));
    expect(r.verdict).toEqual({
      coverage: nb("Jumped to page 12 of 13, skipping pages 2–8 and 10–11"),
      behaviour: nb(`Came back 4 days later and spent 2m${NBSP}50s on page 9 (Pricing), 21.3× the typical time`),
      text: nb(`Jumped to page 12 of 13, skipping pages 2–8 and 10–11. Came back 4 days later and spent 2m${NBSP}50s on page 9 (Pricing), 21.3× the typical time.`),
      page: 9,
    });
    expect(r.pages[8]).toMatchObject({ ms: 170541, typicalMs: 8000, readCount: 6, ratio: 21.3 });
  });

  test("among pages within 10% of the top ratio, the one held longest is named", () => {
    const fx = fixture(13, [{ name: "samLive", visits: [{ events: [[1, 5000, "turn", 5], [5, 34240, "turn", 8], [8, 170541, "turn", 9], [9, 8000, "pagehide"]] }] }]);
    const typical: Record<number, number> = { 5: 4694, 8: 26023 };
    const v = buildVerdict(personOf(fx), 13, undefined, { typicalFor: (page) => ({ typicalMs: typical[page] ?? 4000, readCount: 6 }) });
    expect(v.behaviour).toBe(nb(`Spent 2m${NBSP}50s on page 8, 6.5× the typical time`));
    // Page 5 alone clearly ahead (8.0× against 6.5×) is still named.
    const clear = buildVerdict(personOf(fx), 13, undefined, { typicalFor: (page) => ({ typicalMs: page === 5 ? 4280 : (typical[page] ?? 4000), readCount: 6 }) });
    expect(clear.page).toBe(5);
  });

  test("a return with a standout page on fewer than five stayers drops the ratio", () => {
    const fewPeers = { ...SAMUEL, rows: SAMUEL.rows.slice(0, 4), visits: SAMUEL.visits.filter((v) => SAMUEL.rows.slice(0, 4).some((row) => row.botIdHash === v.botIdHash)), keys: SAMUEL.keys.slice(0, 4) };
    const { r } = personResponse(fewPeers);
    expect(r.verdict.behaviour).toBe(nb(`Came back 4 days later and spent 2m${NBSP}50s on page 9`));
    expect(r.pages[8].ratio).toBeNull();
  });

  test("a last page flicked past is not reaching it; an ascending latest visit that left early got as far", () => {
    const { r } = personResponse(LAST_PAGE_PASSED);
    expect(r.pages[11].state).toBe("passed");
    expect(r.facts.exitPage).toBe(10);
    expect(r.verdict.coverage).toBe(nb("Got as far as page 12 of 12, skipping pages 7–9, and left on page 10"));
    // Page 1 is timed in both visits, so page 10 (21s across both) is the standout.
    expect(r.verdict.behaviour).toBe(nb("Spent 21s on page 10, then left"));
  });

  test("a long out-of-order path is summarised", () => {
    const events: EventSpec[] = [...Array.from({ length: 6 }, (_, i): EventSpec => [i + 1, 5000, "turn", i === 5 ? 10 : i + 2]), [10, 9000, "turn", 11], [11, 7000, "turn", 12], [12, 1000, "turn", 10], [10, 4000, "pagehide"]];
    const fx = fixture(12, [{ name: "aroundMany", visits: [{ events }] }]);
    expect(buildVerdict(personOf(fx), 12).coverage).toBe(nb("Jumped around 9 pages and left on page 10"));
  });

  test("reader 6: 1 → 10 → 9 → 4 went out of order", () => {
    expect(text(BACKWARDS)).toBe(nb("Went to pages 10, 9 and 4 out of order and left on page 4."));
  });

  test("a download is mentioned", () => {
    expect(text(DOWNLOADER)).toBe("Read all 3 pages. Downloaded it.");
    expect(buildVerdict({ ...personOf(DOWNLOADER), hasDetail: false }, 3).text).toBe("No page detail was recorded for this person. Downloaded it.");
  });
});
