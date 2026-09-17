// Run west of UTC, where formatting the month key's UTC midnight in local time showed the previous
// month ("August 2026" over invoices dated Sep 16). Set before any Date/Intl use in this worker, and
// put back afterwards: the lib suite runs every file in one thread, so a leaked TZ would shift the
// dates of whichever test files run after this one.
const previousTz = process.env.TZ;
process.env.TZ = "America/Los_Angeles";

import { afterAll, describe, expect, test } from "vitest";

afterAll(() => {
  if (previousTz === undefined) delete process.env.TZ;
  else process.env.TZ = previousTz;
});

import { formatDayKey, formatMonthLabel } from "@/lib/format/date";

/** The billing invoices API keys months as UTC `YYYY-MM` (fmtMonthUtc). */
const monthKeyUtc = (iso: string) => new Date(iso).toISOString().slice(0, 7);

/** The label in the runtime locale, so the test does not assume English. */
const expected = (year: number, monthIndex: number) =>
  new Intl.DateTimeFormat(undefined, { year: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(Date.UTC(year, monthIndex, 15)),
  );

describe("formatMonthLabel", () => {
  test("the test really runs west of UTC", () => {
    expect(new Date("2026-09-01T00:00:00.000Z").getDate()).toBe(31);
  });

  test("a UTC mid-month invoice date labels its own month", () => {
    const key = monthKeyUtc("2026-09-16T12:00:00.000Z");
    expect(key).toBe("2026-09");
    expect(formatMonthLabel(key)).toBe(expected(2026, 8));
    expect(formatMonthLabel(key)).not.toBe(expected(2026, 7));
  });

  test("a month-boundary date (first instant of the UTC month) labels that month", () => {
    const key = monthKeyUtc("2026-09-01T00:00:00.000Z");
    expect(key).toBe("2026-09");
    expect(formatMonthLabel(key)).toBe(expected(2026, 8));
  });

  test("January does not roll back into the previous year", () => {
    expect(formatMonthLabel(monthKeyUtc("2026-01-01T00:00:00.000Z"))).toBe(expected(2026, 0));
  });

  test("unparseable keys come back unchanged", () => {
    expect(formatMonthLabel("not-a-month")).toBe("not-a-month");
  });

  test("formatDayKey is unchanged: a UTC day key stays that day", () => {
    expect(formatDayKey("2026-09-01")).toBe(
      new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", timeZone: "UTC" }).format(
        new Date(Date.UTC(2026, 8, 1)),
      ),
    );
  });
});
