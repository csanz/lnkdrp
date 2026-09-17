/**
 * Page by page: one row per page with this person's time as a bar, a dashed tick for the doc's
 * typical time on that page (only where 3 people stayed on it), and the passed/unknown/unreached states.
 */
import { formatDwell } from "@/lib/analytics/reading/format";
import type { PersonPageRow } from "@/lib/analytics/reading/types";

const EMERALD = "rgb(16 185 129)";
const HATCH = "repeating-linear-gradient(45deg, rgb(16 185 129 / .35) 0 2px, transparent 2px 5px)";

function Thumb({ page, thumbUrl }: { page: number; thumbUrl: string | null }) {
  return (
    <div className="relative h-[30px] w-10 shrink-0 overflow-hidden rounded-[4px] border border-[var(--border)] bg-[var(--panel-2)]">
      {thumbUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={thumbUrl} alt="" loading="lazy" className="h-full w-full object-cover" />
      ) : (
        <span className="flex h-full w-full items-center justify-center text-[11px] font-semibold text-[var(--muted-2)]">
          {String(page)}
        </span>
      )}
    </div>
  );
}

function Badge({ children }: { children: string }) {
  return (
    <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-px text-[10px] font-semibold text-[var(--muted-2)]">
      {children}
    </span>
  );
}

function PageBarRow({ row, maxMs }: { row: PersonPageRow; maxMs: number }) {
  const unreached = row.state === "unreached";
  const pct = row.ms > 0 && maxMs > 0 ? Math.min(100, (row.ms / maxMs) * 100) : 0;
  const tick =
    row.typicalMs === null
      ? null
      : maxMs > 0 && row.typicalMs <= maxMs
        ? { left: (row.typicalMs / maxMs) * 100, over: false }
        : { left: 100, over: true };

  let track: React.ReactNode;
  let value: string;
  if (row.state === "read") {
    track = (
      <div
        className="h-2.5 rounded-full"
        style={{ width: `${pct}%`, minWidth: row.ms > 0 ? 2 : 0, backgroundColor: EMERALD }}
      />
    );
    value = formatDwell(row.ms);
  } else if (row.state === "passed") {
    track = (
      <div className="flex items-center gap-2">
        <div className="h-2.5 w-3 shrink-0 rounded-sm" style={{ backgroundImage: HATCH }} />
        <span className="truncate text-[11px] text-[var(--muted)]">Passed (under 2s)</span>
      </div>
    );
    value = formatDwell(row.ms);
  } else if (row.state === "unknown") {
    track = <span className="truncate text-[11px] text-[var(--muted)]">Seen · time not recorded</span>;
    value = "—";
  } else {
    track = <span className="truncate text-[11px] text-[var(--muted)]">Not reached</span>;
    value = "—";
  }

  const typicalTitle = row.typicalMs === null ? undefined : `Typical ${formatDwell(row.typicalMs)}`;

  return (
    <li
      data-reader-page={row.page}
      className={`flex min-h-11 items-center gap-3 py-1.5 ${unreached ? "opacity-50" : ""}`}
    >
      <Thumb page={row.page} thumbUrl={row.thumbUrl} />
      <div className="w-24 min-w-0 shrink-0 sm:w-36">
        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-semibold text-[var(--fg)]">{`Page ${row.page}`}</span>
        </div>
        {row.label ? <div className="truncate text-[11px] text-[var(--muted)]">{row.label}</div> : null}
      </div>
      <div className="min-w-0 flex-1">
        <div className="relative flex h-5 items-center">
          <div className="min-w-0 flex-1">{track}</div>
          {tick ? (
            <span
              data-typical-tick
              title={typicalTitle}
              aria-label={typicalTitle}
              className="absolute inset-y-0 w-0 border-l border-dashed border-[var(--muted)]"
              style={{ left: `calc(${tick.left}% - ${tick.over ? 1 : 0}px)` }}
            >
              {tick.over ? (
                <span aria-hidden="true" className="absolute -top-0.5 left-0.5 text-[10px] leading-none text-[var(--muted)]">
                  ›
                </span>
              ) : null}
            </span>
          ) : null}
        </div>
        {row.revisits > 0 || row.leftHere ? (
          <div className="mt-1 flex flex-wrap gap-1">
            {row.revisits > 0 ? <Badge>↺ went back</Badge> : null}
            {row.leftHere ? <Badge>Left here</Badge> : null}
          </div>
        ) : null}
      </div>
      <div className="w-14 shrink-0 text-right text-[13px] tabular-nums text-[var(--fg)]">{value}</div>
    </li>
  );
}

/** One row per page (1..P) plus the typical-time legend when any tick is drawn. */
export default function ReaderPageBars({ pages }: { pages: PersonPageRow[] }) {
  const maxMs = pages.reduce((m, r) => (r.state === "read" || r.state === "passed" ? Math.max(m, r.ms) : m), 0);
  const anyTick = pages.some((r) => r.typicalMs !== null);
  return (
    <div>
      <ul className="divide-y divide-[var(--divider)]">
        {pages.map((row) => (
          <PageBarRow key={row.page} row={row} maxMs={maxMs} />
        ))}
      </ul>
      {anyTick ? (
        <p className="mt-2 text-[11px] text-[var(--muted)]">
          ┊ typical time for people who stayed on this page for 2s or more (shown once 3 have)
        </p>
      ) : null}
    </div>
  );
}
