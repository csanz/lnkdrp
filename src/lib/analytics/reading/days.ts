/**
 * The `days` query parameter for reading analytics: defaults by plan, clamped to 1..365, then to
 * the plan's history limit.
 */
export function parseDaysParam(raw: string | null, o: { plan: string; daysLimit: number | null }): number {
  const fallback = o.plan === "pro" ? 30 : 7;
  const parsed = raw === null ? NaN : Number.parseInt(raw.trim(), 10);
  const n = Number.isFinite(parsed) ? Math.min(365, Math.max(1, parsed)) : fallback;
  return o.daysLimit !== null ? Math.min(n, o.daysLimit) : n;
}
