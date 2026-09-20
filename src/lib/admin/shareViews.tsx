/**
 * Share-view reading: the shapes, the day series, and the overview block.
 *
 * `/a/shareviews` and `/a/shareviews/:docId` are the same reading at two scopes, and used to be
 * two copies of the same 200 lines — same helpers, same cards, drifting apart. They share this
 * file instead, so the fleet view and one document's view cannot disagree about what a day is.
 *
 * The day series are UTC: a share view is stamped in UTC and the buckets have to line up with
 * the stamps, not with whatever timezone the admin is sitting in.
 */
"use client";

import { ADMIN_FIELD_LABEL, ADMIN_STAT_TILE, ADMIN_STAT_VALUE } from "./ui";

export type ShareViewItem = {
  _id: string;
  // No `shareId`: the slug the view was made through is `/s/:shareId`, the document itself, and
  // the admin routes stopped sending it (src/lib/admin/docPrivacy.ts). The doc id identifies the
  // row, and `/a/shareviews/:docId` is where an admin goes from here.
  docId?: { _id?: string; title?: string | null } | string | null;
  pagesSeen?: number[] | null;
  downloads?: number | null;
  downloadsByDay?: Record<string, number> | null;
  createdDate?: string | null;
  updatedDate?: string | null;
  viewerEmail?: string | null;
  viewerUserId?: { _id?: string; email?: string | null; name?: string | null } | string | null;
  viewerIp?: string | null;
};

export type SeriesPoint = { key: string; label: string; value: number };

/** `YYYY-MM-DD` in UTC. */
function toUtcDayKey(d: Date) {
  return d.toISOString().slice(0, 10);
}

/** A date that parsed, or null. */
export function safeDate(v: string | null | undefined): Date | null {
  if (!v) return null;
  const d = new Date(v);
  if (Number.isNaN(d.valueOf())) return null;
  return d;
}

/** Every row's per-day download counts, added together. */
export function sumDownloadsByDay(items: ShareViewItem[]) {
  const out: Record<string, number> = {};
  for (const item of items) {
    const m = item.downloadsByDay ?? null;
    if (!m || typeof m !== "object") continue;
    for (const [k, raw] of Object.entries(m)) {
      const n = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(n) || n <= 0) continue;
      out[k] = (out[k] ?? 0) + n;
    }
  }
  return out;
}

/** One point per day for the last `days` days, counting rows by their last-seen stamp. */
export function buildDailySeriesFromItems(items: ShareViewItem[], days: number): SeriesPoint[] {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const d = safeDate(item.updatedDate ?? item.createdDate ?? null);
    if (!d) continue;
    const dayKey = toUtcDayKey(d);
    counts[dayKey] = (counts[dayKey] ?? 0) + 1;
  }
  return buildDailySeriesFromDayMap(counts, days);
}

/** One point per day for the last `days` days, reading an existing day → count map. */
export function buildDailySeriesFromDayMap(dayMap: Record<string, number>, days: number): SeriesPoint[] {
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  start.setUTCDate(start.getUTCDate() - (days - 1));

  const series: SeriesPoint[] = [];
  for (let i = 0; i < days; i++) {
    const d = new Date(start);
    d.setUTCDate(start.getUTCDate() + i);
    const key = toUtcDayKey(d);
    const label = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
    const v = typeof dayMap[key] === "number" ? dayMap[key] : Number(dayMap[key] ?? 0);
    series.push({ key, label, value: Number.isFinite(v) ? Math.max(0, v) : 0 });
  }
  return series;
}

/** Who this row belongs to: the email they gave, the account they signed in with, or nobody. */
export function viewerLabel(item: ShareViewItem) {
  const email = item.viewerEmail ?? null;
  if (email) return email;
  const u = item.viewerUserId && typeof item.viewerUserId === "object" ? item.viewerUserId : null;
  if (u?.email) return u.email;
  if (u?.name) return u.name;
  return "anonymous";
}

/** The document a row points at, whether the route populated it or left an id. */
export function docInfo(item: ShareViewItem): { docId: string | null; title: string } {
  if (item.docId && typeof item.docId === "object") {
    const id = typeof item.docId._id === "string" ? item.docId._id : null;
    const title = typeof item.docId.title === "string" && item.docId.title.trim() ? item.docId.title : "(untitled)";
    return { docId: id, title };
  }
  return { docId: null, title: "(unknown doc)" };
}

/** How many pages this viewer reached — the bucket the distribution counts it in. */
export function pagesBucket(pages: number): string {
  if (pages <= 0) return "0";
  if (pages === 1) return "1";
  if (pages <= 3) return "2-3";
  if (pages <= 6) return "4-6";
  if (pages <= 10) return "7-10";
  return "11+";
}

export const PAGES_BUCKETS = ["0", "1", "2-3", "4-6", "7-10", "11+"] as const;

/* ------------------------------------------------------------------- figures */

/** One figure: its name above, its value below, nothing else competing. */
export function StatTile({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`${ADMIN_STAT_TILE} ${className ?? ""}`}>
      <div className={ADMIN_FIELD_LABEL}>{label}</div>
      <div className={ADMIN_STAT_VALUE}>{value}</div>
      {sub ? <div className="mt-0.5 truncate text-[11.5px] leading-4 text-[var(--muted-2)]">{sub}</div> : null}
    </div>
  );
}

/** A smooth path through the series, in the app's chart language: an area, never bars. */
function areaPaths(series: SeriesPoint[], w: number, h: number, max: number) {
  const n = series.length;
  if (n === 0) return { line: "", area: "" };
  const stepX = n > 1 ? w / (n - 1) : 0;
  const y = (v: number) => (max > 0 ? h - (v / max) * (h - 4) - 2 : h - 2);
  const pts = series.map((p, i) => ({ x: i * stepX, y: y(p.value) }));

  // Smooth through the midpoints: each real point becomes the control of one quadratic, so the
  // curve never overshoots into negative territory the way a cubic spline can.
  let line = `M ${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 1; i < pts.length; i++) {
    const prev = pts[i - 1];
    const cur = pts[i];
    const mid = { x: (prev.x + cur.x) / 2, y: (prev.y + cur.y) / 2 };
    line += ` Q ${prev.x.toFixed(2)} ${prev.y.toFixed(2)} ${mid.x.toFixed(2)} ${mid.y.toFixed(2)}`;
  }
  const last = pts[pts.length - 1];
  line += ` L ${last.x.toFixed(2)} ${last.y.toFixed(2)}`;
  const area = `${line} L ${last.x.toFixed(2)} ${h} L ${pts[0].x.toFixed(2)} ${h} Z`;
  return { line, area };
}

/**
 * A day series as a small area chart: title, peak, the curve, and the span beneath it.
 *
 * The card fills its grid row and the plot takes whatever height is left, so a chart beside a
 * taller card is not a curve floating over 70px of blank panel.
 */
export function DaySeries({
  title,
  subtitle,
  series,
  className,
}: {
  title: string;
  subtitle?: string;
  series: SeriesPoint[];
  className?: string;
}) {
  const max = series.reduce((m, p) => Math.max(m, p.value), 0);
  const total = series.reduce((m, p) => m + p.value, 0);
  const w = 300;
  const h = 56;
  const { line, area } = areaPaths(series, w, h, max);
  const gradientId = `admin-area-${title.replace(/[^a-z0-9]+/gi, "-").toLowerCase()}`;

  return (
    <div
      className={`flex h-full min-w-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3.5 py-3 ${className ?? ""}`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="truncate text-[13px] font-semibold leading-5 text-[var(--fg)]">{title}</div>
          {subtitle ? (
            <div className="mt-0.5 truncate text-[11.5px] leading-4 text-[var(--muted-2)]">{subtitle}</div>
          ) : null}
        </div>
        <div className="shrink-0 text-right text-[11.5px] leading-4 tabular-nums text-[var(--muted-2)]">
          <div>{total.toLocaleString()} total</div>
          <div>peak {max.toLocaleString()}</div>
        </div>
      </div>
      <svg
        viewBox={`0 0 ${w} ${h}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${title}: ${total} over ${series.length} days, peak ${max}`}
        className="mt-3 min-h-[56px] w-full flex-1 text-[var(--primary-bg)]"
      >
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="currentColor" stopOpacity="0.32" />
            <stop offset="100%" stopColor="currentColor" stopOpacity="0.02" />
          </linearGradient>
        </defs>
        {area ? <path d={area} fill={`url(#${gradientId})`} /> : null}
        {line ? (
          <path
            d={line}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        ) : null}
      </svg>
      <div className="mt-1 flex justify-between text-[11px] leading-4 text-[var(--muted-2)]">
        <span>{series[0]?.label ?? ""}</span>
        <span>{series[series.length - 1]?.label ?? ""}</span>
      </div>
    </div>
  );
}

/** The pages-seen histogram: one bar per bucket, counts on the right. */
export function PagesDistribution({
  counts,
  className,
}: {
  counts: Record<string, number>;
  className?: string;
}) {
  const max = Math.max(...PAGES_BUCKETS.map((k) => counts[k] ?? 0), 1);
  return (
    <div
      className={`flex h-full min-w-0 flex-col rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3.5 py-3 ${className ?? ""}`}
    >
      <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">Pages seen</div>
      <div className="mt-0.5 text-[11.5px] leading-4 text-[var(--muted-2)]">Viewers per bucket</div>
      <div className="mt-3 flex flex-1 flex-col justify-between gap-1.5">
        {PAGES_BUCKETS.map((k) => {
          const v = counts[k] ?? 0;
          const pct = Math.round((v / max) * 100);
          return (
            <div key={k} className="flex items-center gap-2.5">
              <div className="w-9 shrink-0 text-[11.5px] leading-4 tabular-nums text-[var(--muted-2)]">{k}</div>
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-[var(--panel-2)]">
                <div
                  className="h-1.5 rounded-full bg-[var(--primary-bg)] opacity-70"
                  style={{ width: `${v > 0 ? Math.max(3, pct) : 0}%` }}
                />
              </div>
              <div className="w-8 shrink-0 text-right text-[11.5px] leading-4 tabular-nums text-[var(--muted-2)]">
                {v}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
