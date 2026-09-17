/**
 * The `days` and `tz` query parameters for reading analytics, and calendar-day keys.
 */

/** `days`: defaults by plan, clamped to 1..365, then to the plan's history limit. */
export function parseDaysParam(raw: string | null, o: { plan: string; daysLimit: number | null }): number {
  const fallback = o.plan === "pro" ? 30 : 7;
  const parsed = raw === null ? NaN : Number.parseInt(raw.trim(), 10);
  const n = Number.isFinite(parsed) ? Math.min(365, Math.max(1, parsed)) : fallback;
  return o.daysLimit !== null ? Math.min(n, o.daysLimit) : n;
}

const dayFormatters = new Map<string, Intl.DateTimeFormat>();

/** A `tz` query value when it is an IANA zone this runtime knows, else "UTC". */
export function parseTimeZoneParam(raw: string | null): string {
  const tz = (raw ?? "").trim();
  if (!tz || tz === "UTC") return "UTC";
  return Intl.supportedValuesOf("timeZone").includes(tz) ? tz : "UTC";
}

/** The calendar day (YYYY-MM-DD) an instant falls on in `timeZone`. */
export function dayKeyInZone(ms: number, timeZone: string): string {
  let f = dayFormatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" });
    dayFormatters.set(timeZone, f);
  }
  const parts = f.formatToParts(new Date(ms));
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/** Every calendar day from `first` to `last` inclusive (both YYYY-MM-DD); empty when first > last. */
export function dayKeysBetween(first: string, last: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${last}T00:00:00.000Z`);
  for (let t = Date.parse(`${first}T00:00:00.000Z`); Number.isFinite(t) && t <= end; t += 86_400_000) {
    out.push(new Date(t).toISOString().slice(0, 10));
  }
  return out;
}
