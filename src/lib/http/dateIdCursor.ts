/**
 * Keyset cursor over a `(date desc, _id desc)` sort, as a base64url string.
 *
 * The same shape `GET /api/changes` uses for its `nextCursor`, lifted out so other paged lists
 * (the admin share-views list, code review M13) can page the same way instead of returning a whole
 * collection. Malformed input decodes to null, which callers treat as "first page".
 */
import { Types } from "mongoose";

export type DateIdCursor = { date: Date; id: Types.ObjectId };

/** Encode a cursor: `<iso date>:<object id>`, base64url. */
export function encodeDateIdCursor(c: DateIdCursor): string {
  return Buffer.from(`${c.date.toISOString()}:${String(c.id)}`, "utf8").toString("base64url");
}

/** Decode a cursor; null for anything malformed or absent. */
export function decodeDateIdCursor(raw: string | null | undefined): DateIdCursor | null {
  if (!raw) return null;
  try {
    const s = Buffer.from(raw, "base64url").toString("utf8");
    const idx = s.lastIndexOf(":");
    if (idx <= 0) return null;
    const date = new Date(s.slice(0, idx));
    const id = s.slice(idx + 1);
    if (!Number.isFinite(date.getTime()) || !Types.ObjectId.isValid(id)) return null;
    return { date, id: new Types.ObjectId(id) };
  } catch {
    return null;
  }
}

/**
 * The filter clause for "rows after `cursor`" under a `{ [field]: -1, _id: -1 }` sort: an earlier
 * date, or the same date with a smaller id.
 */
export function dateIdCursorClause(field: string, cursor: DateIdCursor): Record<string, unknown> {
  return { $or: [{ [field]: { $lt: cursor.date } }, { [field]: cursor.date, _id: { $lt: cursor.id } }] };
}

/** Parse a `?limit=` value into `[1, max]`, falling back to `fallback`. */
export function parseLimit(raw: string | null | undefined, fallback: number, max: number): number {
  const n = Number.parseInt(String(raw ?? ""), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}
