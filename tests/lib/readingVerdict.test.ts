/**
 * Two-slot verdict (spec §3.6) on the hand-built fixtures.
 */
import { describe, expect, test } from "vitest";

import { buildPersonResponse, buildReadingResponse, buildVerdict } from "@/lib/analytics/reading";

import {
  BACKWARDS,
  DAY,
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
  T0,
  coreOf,
  docOf,
  fixture,
  personOf,
  type EventSpec,
  type Fixture,
} from "./fixtures/readingFixtures";

const NBSP = "\u00a0";
const WJ = "\u2060";
/** Expected copy with the no-break space after "page(s)" and the word joiners around a range's en dash. */
const nb = (s: string) => s.replace(/\b(pages?) (\d)/g, `$1${NBSP}$2`).replace(/(\d)–(\d)/g, `$1${WJ}–${WJ}$2`);

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
    ["F6", F6, "Reached the last page, jumping past pages 3–4. Came back 3 days later and left on page 6."],
    ["F7", F7, "Stopped at page 2 of 4."],
    ["F8", F8, "Read all 3 pages."],
    ["F11", F11, "Read the only page."],
    ["F12", F12, "Went through all 3 pages. Passed over page 2 quickly."],
    ["SK1", SK1, "Went through all 10 pages. Passed over pages 2–9 quickly."],
    ["Nadia", NADIA, "Went through all 12 pages."],
    ["Maya", MAYA, "Stopped at page 2 of 12."],
    ["Isaac", ISAAC, "Jumped to page 10 of 13, jumping past pages 2–9. Spent 57s on page 10, then left."],
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
    expect(buildVerdict(personOf(seenOnly(5, [1, 3])), 5).coverage).toBe(nb("Jumped to page 3 of 5, jumping past page 2"));
    expect(buildVerdict(personOf(seenOnly(10, [1, 2, 6, 10])), 10).coverage).toBe(nb("Reached the last page, jumping past pages 3–5 and 7–9"));
    expect(buildVerdict(personOf(seenOnly(10, [1, 3, 5, 7, 10])), 10).coverage).toBe("Reached the last page, jumping past 5 of 10 pages");
    expect(buildVerdict(personOf(seenOnly(12, [1, 2, 5, 9])), 12).coverage).toBe(nb("Jumped to page 9 of 12, jumping past pages 3–4 and 6–8"));
    // Word joiners around the en dash, so a range never breaks across lines.
    expect(buildVerdict(personOf(seenOnly(12, [1, 2, 5, 9])), 12).coverage).toContain("3\u2060–\u20604");
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
    expect(buildVerdict(nextDay, 3, undefined, { tz: LA }).behaviour).toBe(nb("Came back the next day and left on page 2"));
    expect(buildVerdict(nextDay, 3, undefined, { tz: "UTC" }).behaviour).toBe(nb("Came back 2 days later and left on page 2"));
    expect(buildVerdict(personOf(returner("2026-08-28T10:09:00.000Z", 67.6)), 3, undefined, { tz: LA }).behaviour).toBe(nb("Came back 2 days later and left on page 2"));
    expect(buildVerdict(personOf(returner("2026-09-10T15:00:00.000Z", 14)), 3, undefined, { tz: LA }).text).toBe(nb("Got as far as page 2 of 3. Came back 14 hours later and left on page 2."));
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

  test("a flick past the cover is not the passed page named when the document has more than two pages", () => {
    const fx = fixture(8, [
      {
        name: "coverFlick",
        visits: [{ events: [[1, 500, "turn"], [2, 5000, "turn"], [3, 5000, "turn"], [4, 5000, "turn"], [5, 5000, "turn"], [6, 500, "turn"], [7, 5000, "turn"], [8, 5000, "pagehide"]] }],
      },
    ]);
    const p = personOf(fx);
    expect([p.cells[0].state, p.cells[5].state, p.maxPage]).toEqual(["passed", "passed", 8]);
    expect(buildVerdict(p, 8).text).toBe(nb("Went through all 8 pages. Passed over page 6 quickly."));
  });
});

describe("verdict shapes found live", () => {
  test("Samuel: a page only the first visit held is not named after the return", () => {
    const { r } = personResponse(SAMUEL, docOf(13, { 9: "pricing" }));
    expect(r.verdict).toEqual({
      coverage: nb("Got as far as page 12 of 13, jumping past pages 2–8 and 10–11"),
      // Page 9 (21×) was visit 1 only; its page row still says so.
      behaviour: nb("Came back 4 days later and left on page 12"),
      text: nb("Got as far as page 12 of 13, jumping past pages 2–8 and 10–11. Came back 4 days later and left on page 12."),
      page: null,
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

  test("Grace: the coverage names no exit, so the first visit's exit is not contradicted", () => {
    const fx = fixture(12, [
      {
        name: "grace",
        visits: [
          { visitId: "gb-v1", start: T0, events: [[1, 5000, "turn", 2], [2, 6000, "turn", 3], [3, 7000, "turn", 4], [4, 6000, "pagehide"]] },
          { visitId: "gb-v2", start: T0 + 13 * HOUR, events: [[1, 4000, "turn", 2], [2, 5000, "turn", 3], [3, 6000, "pagehide"]] },
        ],
      },
    ]);
    const v = buildVerdict(personOf(fx), 12, undefined, { tz: "UTC" });
    const [before, after] = v.text.split("Came back");
    expect(before).not.toContain("left on");
    expect(after).toContain(nb("left on page 3"));
    expect(v.text).toBe(nb("Got as far as page 4 of 12. Came back 12 hours later and left on page 3."));
  });

  test("Samuel's return: no jump the first visit never made, no return-only ratio, the exit after the standout", () => {
    const fx = fixture(13, [
      {
        name: "samuelReturn",
        visits: [
          { visitId: "sr-v1", start: T0, events: [[1, 5000, "turn", 9], [9, 60000, "pagehide"]] },
          { visitId: "sr-v2", start: T0 + 4 * DAY, events: [[1, 4000, "turn", 8], [8, 97000, "turn", 9], [9, 1000, "turn", 8], [8, 20000, "turn", 12], [12, 5000, "pagehide"]] },
        ],
      },
    ]);
    const v = buildVerdict(personOf(fx), 13, undefined, { tz: "UTC", typicalFor: (page) => ({ typicalMs: page === 8 ? 26000 : 5000, readCount: 9 }) });
    expect(v.text).not.toContain("Jumped to");
    expect(v.behaviour).not.toContain("×");
    expect(v).toMatchObject({
      coverage: nb("Got as far as page 12 of 13, jumping past pages 2–7 and 10–11"),
      behaviour: nb(`Came back 4 days later, spent 1m${NBSP}57s on page 8, then left on page 12`),
      page: 8,
    });
  });

  test("reader 14: with no return standout, a first-visit page is never named after the return", () => {
    const fx = fixture(12, [
      {
        name: "reader14",
        visits: [
          { visitId: "r14-v1", start: T0, events: [[1, 4000, "turn", 2], [2, 5000, "turn", 3], [3, 27000, "turn", 4], [4, 5000, "turn", 5], [5, 5000, "turn", 6], [6, 6000, "pagehide"]] },
          { visitId: "r14-v2", start: T0 + DAY + HOUR, events: [[1, 3000, "turn", 10], [10, 4000, "turn", 11], [11, 5000, "turn", 12], [12, 800, "turn", 11], [11, 4000, "turn", 10], [10, 5000, "pagehide"]] },
        ],
      },
    ]);
    const p = personOf(fx);
    for (const opts of [{ tz: "UTC" }, { tz: "UTC", typicalFor: () => ({ typicalMs: 5000, readCount: 9 }) }]) {
      expect(buildVerdict(p, 12, undefined, opts)).toMatchObject({
        text: nb("Got as far as page 12 of 12, jumping past pages 7–9. Came back the next day and left on page 10."),
        page: null,
      });
    }
  });

  test("Samuel Laurent: a page split over two visits states the return visit's own time", () => {
    const fx = fixture(13, [
      {
        name: "laurent",
        visits: [
          { visitId: "sl-v1", start: T0, events: [[1, 5000, "turn", 8], [8, 73000, "turn", 9], [9, 6000, "pagehide"]] },
          { visitId: "sl-v2", start: T0 + 4 * DAY, events: [[1, 4000, "turn", 8], [8, 97000, "turn", 12], [12, 5000, "pagehide"]] },
        ],
      },
    ]);
    const v = buildVerdict(personOf(fx), 13, undefined, { tz: "UTC" });
    expect(v.behaviour).toBe(nb(`Came back 4 days later, spent 1m${NBSP}37s on page 8, then left on page 12`));
    expect(v.page).toBe(8);
    const rated = buildVerdict(personOf(fx), 13, undefined, { tz: "UTC", typicalFor: (page) => ({ typicalMs: page === 8 ? 10000 : 4000, readCount: 6 }) });
    expect(rated.behaviour).toBe(v.behaviour);
  });

  test("a standout only across visits is not named for a returner", () => {
    const visit = (visitId: string, start: number) => ({ visitId, start, events: [[1, 3000, "turn", 5], [5, 15000, "turn", 6], [6, 3000, "pagehide"]] as EventSpec[] });
    const fx = fixture(8, [{ name: "split", visits: [visit("sp-v1", T0), visit("sp-v2", T0 + 2 * DAY)] }]);
    const p = personOf(fx);
    expect(buildVerdict(p, 8, undefined, { tz: "UTC" })).toMatchObject({ behaviour: nb("Came back 2 days later and left on page 6"), page: null });
    const rated = buildVerdict(p, 8, undefined, { tz: "UTC", typicalFor: () => ({ typicalMs: 5000, readCount: 5 }) });
    expect(rated.behaviour).toBe(nb("Came back 2 days later and left on page 6"));
  });

  test("a returner's return standout that is also where they left", () => {
    const fx = fixture(8, [
      {
        name: "leftThere",
        visits: [
          { visitId: "lt-v1", start: T0, events: [[1, 5000, "turn", 2], [2, 5000, "pagehide"]] },
          { visitId: "lt-v2", start: T0 + 2 * DAY, events: [[1, 3000, "turn", 5], [5, 45000, "pagehide"]] },
        ],
      },
    ]);
    expect(buildVerdict(personOf(fx), 8, (k) => (k === 5 ? "Pricing" : null), { tz: "UTC" }).behaviour).toBe(nb("Came back 2 days later, spent 45s on page 5 (Pricing) and left there"));
  });

  test("a returner's out-of-order latest visit is not described as their path", () => {
    const fx = fixture(12, [
      {
        name: "reader21",
        visits: [
          { visitId: "r21-v1", start: T0, events: Array.from({ length: 6 }, (_, i): EventSpec => (i < 5 ? [i + 1, 5000, "turn", i + 2] : [6, 5000, "pagehide"])) },
          { visitId: "r21-v2", start: T0 + 2 * DAY, events: [[1, 4000, "turn", 11], [11, 7000, "turn", 10], [10, 12000, "pagehide"]] },
        ],
      },
    ]);
    const v = buildVerdict(personOf(fx), 12, undefined, { tz: "UTC" });
    expect(v.text).not.toContain("out of order");
    expect(v.coverage).toBe(nb("Got as far as page 11 of 12, jumping past pages 7–9"));
    expect(v.behaviour).toBe(nb("Came back 2 days later and left on page 10"));
    // A single visit with the same path keeps the out-of-order wording.
    const once = fixture(12, [{ name: "once21", visits: [{ events: [[1, 4000, "turn", 11], [11, 7000, "turn", 10], [10, 12000, "pagehide"]] }] }]);
    expect(buildVerdict(personOf(once), 12).coverage).toBe(nb("Went to pages 11 and 10 out of order and left on page 10"));
  });

  test("a last page flicked past is not reaching it; an ascending latest visit that left early got as far", () => {
    const { r } = personResponse(LAST_PAGE_PASSED);
    expect(r.pages[11].state).toBe("passed");
    expect(r.facts.exitPage).toBe(10);
    expect(r.verdict.coverage).toBe(nb("Got as far as page 12 of 12, jumping past pages 7–9, and left on page 10"));
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
