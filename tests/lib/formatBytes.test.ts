// The file-size line in version history and on the document page. The cases that matter are the
// ones with nothing to compare against: the first version, and old upload rows written before
// `sizeBytes` existed. Those must read as "no delta", never as "0 B" or "NaN".
import { describe, expect, test } from "vitest";

import { formatBytes, formatPageCount, formatSizeChangeLine, sizeDelta, toBytes } from "@/lib/format/bytes";

const MB = 1024 * 1024;
const KB = 1024;
/** The real minus sign the helper uses, so the expectations do not silently pass on a hyphen. */
const MINUS = "−";

describe("formatBytes", () => {
  test("uses binary units, no decimals below MB", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2 * KB)).toBe("2 KB");
    expect(formatBytes(1_800 * KB)).toBe("1.8 MB");
    expect(formatBytes(3 * 1024 * MB)).toBe("3.0 GB");
  });

  test("nothing to show is null, never a zero or a NaN", () => {
    expect(formatBytes(0)).toBeNull();
    expect(formatBytes(null)).toBeNull();
    expect(formatBytes(undefined)).toBeNull();
    expect(formatBytes(-5)).toBeNull();
    expect(formatBytes(Number.NaN)).toBeNull();
    expect(formatBytes("not a number")).toBeNull();
    expect(formatBytes({})).toBeNull();
  });

  test("accepts numeric strings, as sparse upload rows can carry them", () => {
    expect(toBytes("1048576")).toBe(MB);
    expect(formatBytes("1048576")).toBe("1.0 MB");
  });
});

describe("sizeDelta", () => {
  test("a smaller new file reports a signed size and percentage", () => {
    const d = sizeDelta(3.5 * MB, 1.7 * MB);
    expect(d).not.toBeNull();
    expect(d!.direction).toBe("smaller");
    expect(d!.bytes).toBeLessThan(0);
    expect(d!.label).toBe(`${MINUS}1.8 MB`);
    expect(d!.percent).toBe(`${MINUS}51%`);
  });

  test("a bigger new file reports a plus sign", () => {
    const d = sizeDelta(2 * MB, 3 * MB);
    expect(d!.direction).toBe("larger");
    expect(d!.label).toBe("+1.0 MB");
    expect(d!.percent).toBe("+50%");
  });

  test("an unknown previous size has no delta at all", () => {
    expect(sizeDelta(null, 2 * MB)).toBeNull();
    expect(sizeDelta(undefined, 2 * MB)).toBeNull();
    expect(sizeDelta(Number.NaN, 2 * MB)).toBeNull();
    // And an unknown NEW size is equally unusable.
    expect(sizeDelta(2 * MB, null)).toBeNull();
  });

  test("identical sizes are 'same', with no label and no percentage", () => {
    const d = sizeDelta(2 * MB, 2 * MB);
    expect(d).toEqual({ bytes: 0, direction: "same", label: null, percent: null });
  });

  test("a change under half a percent drops the percentage rather than printing 0%", () => {
    const d = sizeDelta(100 * MB, 100 * MB + 200 * KB);
    expect(d!.direction).toBe("larger");
    expect(d!.label).toBe("+200 KB");
    expect(d!.percent).toBeNull();
  });

  test("growing from an empty previous version has a label but no percentage", () => {
    const d = sizeDelta(0, 1 * MB);
    expect(d!.direction).toBe("larger");
    expect(d!.label).toBe("+1.0 MB");
    expect(d!.percent).toBeNull();
  });
});

describe("formatSizeChangeLine", () => {
  test("the optimized-deck case the owner saw", () => {
    expect(formatSizeChangeLine(3.5 * MB, 1.7 * MB)).toBe(`1.7 MB · ${MINUS}1.8 MB (${MINUS}51%)`);
  });

  test("the first version shows its size and nothing else", () => {
    expect(formatSizeChangeLine(null, 1.7 * MB)).toBe("1.7 MB");
  });

  test("a re-upload of the same file says so instead of trailing off", () => {
    expect(formatSizeChangeLine(1.7 * MB, 1.7 * MB)).toBe("1.7 MB · no change");
  });

  test("no new size means no line", () => {
    expect(formatSizeChangeLine(3.5 * MB, null)).toBeNull();
    expect(formatSizeChangeLine(null, null)).toBeNull();
    expect(formatSizeChangeLine(3.5 * MB, 0)).toBeNull();
  });
});

describe("formatPageCount", () => {
  test("singular and plural, and nothing for an unrecorded count", () => {
    expect(formatPageCount(1)).toBe("1 page");
    expect(formatPageCount(12)).toBe("12 pages");
    expect(formatPageCount(0)).toBeNull();
    expect(formatPageCount(null)).toBeNull();
    expect(formatPageCount(Number.NaN)).toBeNull();
  });
});
