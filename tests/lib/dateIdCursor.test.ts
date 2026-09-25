/**
 * Keyset cursor helpers behind the bounded admin share-views list (code review 2026-09-23, M13).
 */
import { Types } from "mongoose";
import { describe, expect, it } from "vitest";

import { dateIdCursorClause, decodeDateIdCursor, encodeDateIdCursor, parseLimit } from "@/lib/http/dateIdCursor";

describe("dateIdCursor", () => {
  const id = new Types.ObjectId("64b0c0ffee0000000000e003");
  const date = new Date("2026-09-25T10:00:00.123Z");

  it("round-trips a date and id", () => {
    const decoded = decodeDateIdCursor(encodeDateIdCursor({ date, id }));
    expect(decoded?.date.toISOString()).toBe(date.toISOString());
    expect(String(decoded?.id)).toBe(String(id));
  });

  it("decodes malformed input to null (first page)", () => {
    expect(decodeDateIdCursor(null)).toBeNull();
    expect(decodeDateIdCursor("")).toBeNull();
    expect(decodeDateIdCursor("not base64 at all !!")).toBeNull();
    expect(decodeDateIdCursor(Buffer.from("nodate:nope").toString("base64url"))).toBeNull();
    expect(decodeDateIdCursor(Buffer.from("2026-09-25T10:00:00.000Z:notanid").toString("base64url"))).toBeNull();
  });

  it("builds the strictly-after clause for a descending date/id sort", () => {
    expect(dateIdCursorClause("updatedDate", { date, id })).toEqual({
      $or: [{ updatedDate: { $lt: date } }, { updatedDate: date, _id: { $lt: id } }],
    });
  });

  it("parseLimit falls back and caps", () => {
    expect(parseLimit(null, 100, 500)).toBe(100);
    expect(parseLimit("abc", 100, 500)).toBe(100);
    expect(parseLimit("0", 100, 500)).toBe(100);
    expect(parseLimit("50", 100, 500)).toBe(50);
    expect(parseLimit("9999", 100, 500)).toBe(500);
  });
});
