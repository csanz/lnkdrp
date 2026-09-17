"use client";

/**
 * The stats header above the `/activity` feed.
 *
 * Two halves of one question. Left: what was done in the window — documents added, replaced,
 * archived or deleted, links and projects created. Right: who did it, as a donut with one slice per
 * agent client and one for everything people did in the app.
 *
 * What it deliberately does not show: views, opens and downloads. Those are how a document
 * performed, which is `/metrics`; this page is what happened in the workspace. The split is enforced
 * in `src/lib/activity/summary.ts`, not here.
 *
 * It is a header, not a dashboard: one card, a fixed 30-day window named in the copy so no number is
 * ambiguous, and nothing at all when the workspace has done nothing yet (the feed's own empty state
 * speaks instead). The donut disappears too when every action was a person's — a circle of one
 * colour says nothing that the counts have not already said.
 *
 * The numbers are workspace-wide for the window and do not follow the feed's filters: the donut
 * answers "agents or us", which a "Who: agents" filter would reduce to a single slice.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { subscribeRealtime } from "@/lib/client/realtime";
import { Cell, Pie, PieChart, Tooltip } from "recharts";

import { formatShare } from "@/lib/charts/donut";
import {
  ACTIVITY_SUMMARY_BUCKETS,
  emptyCounts,
  type ActorSlice,
  type ActivitySummaryCountKey,
} from "@/lib/activity/summary";

/** Window the header covers. Fixed on purpose — a range control would make this a dashboard. */
const DAYS = 30;
/** Minimum spacing between refreshes triggered by live activity frames. */
const REFRESH_MIN_MS = 15_000;

/** Donut size in px (its own square viewBox), and the ring's thickness. */
const DONUT_SIZE = 88;
const DONUT_THICKNESS = 15;

/**
 * Slice colours, in the order the API returns slices (people first, then agent clients by volume).
 *
 * Three categorical hues, validated as a set against both surfaces; the folded tail and anything
 * past the third slot take the de-emphasis grey rather than a generated hue.
 */
const SLICE_COLORS = ["var(--chart-actor-1)", "var(--chart-actor-2)", "var(--chart-actor-3)"] as const;
const REST_COLOR = "var(--chart-actor-rest)";

/** Colour for the slice at `index`: its hue while the hues last, the de-emphasis grey after that. */
function sliceColor(slice: ActorSlice, index: number): string {
  if (slice.kind === "other") return REST_COLOR;
  return SLICE_COLORS[index] ?? REST_COLOR;
}

type SummaryResponse = {
  days: number;
  counts: Record<ActivitySummaryCountKey, number>;
  actors: { total: number; people: number; agents: number; slices: ActorSlice[] };
};

/** `3 actions` / `1 action`. */
function actionsLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "action" : "actions"}`;
}

/** The counts and the actor donut for the last {@link DAYS} days, or nothing when there is neither. */
export default function ActivityStatsHeader() {
  const [data, setData] = useState<SummaryResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const lastFetchRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const load = useCallback(async () => {
    lastFetchRef.current = Date.now();
    try {
      const res = await fetchWithTempUser(`/api/activity/summary?days=${DAYS}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as SummaryResponse | null;
      if (!json || typeof json !== "object") return;
      setData({
        days: typeof json.days === "number" ? json.days : DAYS,
        counts: { ...emptyCounts(), ...(json.counts ?? {}) },
        actors: {
          total: json.actors?.total ?? 0,
          people: json.actors?.people ?? 0,
          agents: json.actors?.agents ?? 0,
          slices: Array.isArray(json.actors?.slices) ? json.actors.slices : [],
        },
      });
    } catch {
      // The feed below is unaffected; the header simply stays as it was (or absent on first load).
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    void load().finally(() => {
      if (!cancelled) setLoading(false);
    });
    // Live: a new activity row can change these numbers, but they move far more slowly than the
    // feed, so refreshes are spaced rather than one per frame.
    const unsubscribe = subscribeRealtime("activity", () => {
      const since = Date.now() - lastFetchRef.current;
      if (since >= REFRESH_MIN_MS) {
        void load();
        return;
      }
      if (timerRef.current !== null) return;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        void load();
      }, REFRESH_MIN_MS - since);
    });
    return () => {
      cancelled = true;
      unsubscribe();
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
    };
  }, [load]);

  if (loading) {
    // Reserves the card's height so the first feed row does not jump once the numbers land.
    return <div aria-hidden="true" className="mb-6 h-[104px] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] motion-safe:animate-pulse" />;
  }
  if (!data) return null;

  const counts = data.counts;
  const total = data.actors.total;
  // Nothing has happened here yet: the feed's own empty state is the whole message.
  if (!total && ACTIVITY_SUMMARY_BUCKETS.every((b) => !counts[b.id])) return null;

  const slices = data.actors.slices;
  // One slice is a circle of a single colour, which tells a reader nothing the counts have not.
  const showDonut = slices.length > 1;

  return (
    <section aria-label={`What happened in the last ${data.days} days`} className="mb-6">
      <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3.5">
        <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
          <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
            Last {data.days} days
          </h2>
          <span className="text-[11px] tabular-nums text-[var(--muted-2)]">{actionsLabel(total)}</span>
        </div>

        <div className="mt-3 flex flex-col gap-5 sm:flex-row sm:items-center sm:justify-between">
          <dl className="flex min-w-0 flex-1 flex-wrap items-start gap-x-7 gap-y-3">
            {ACTIVITY_SUMMARY_BUCKETS.map((b) => (
              <div key={b.id} className="min-w-0">
                <dd className="text-[20px] font-semibold leading-6 tabular-nums text-[var(--fg)]">
                  {counts[b.id].toLocaleString()}
                </dd>
                <dt className="mt-0.5 text-[11px] leading-4 text-[var(--muted-2)]">{b.label}</dt>
              </div>
            ))}
          </dl>

          {showDonut ? <ActorDonut slices={slices} total={total} days={data.days} /> : null}
        </div>

        <p className="mt-3 text-[11px] leading-4 text-[var(--muted-2)]">
          {showDonut
            ? "What was done in this workspace, and who did it. Views and downloads are on Metrics."
            : "What was done in this workspace. Views and downloads are on Metrics."}
        </p>
      </div>
    </section>
  );
}

/**
 * The donut plus its legend.
 *
 * Recharts, like every other chart in the app (`/metrics`'s hero and the document charts) - the
 * first cut drew its own arcs and read as a different product beside them. The legend is not
 * decoration: it carries every slice's name and count, so identity never rests on colour alone.
 */
function ActorDonut({ slices, total, days }: { slices: ActorSlice[]; total: number; days: number }) {
  const data = slices.map((s, i) => ({ key: s.key, label: s.label, value: s.count, fill: sliceColor(s, i) }));
  if (!data.length) return null;
  const summary = slices.map((s) => `${s.label} ${formatShare(s.count / total)}`).join(", ");

  return (
    <div className="flex shrink-0 items-center gap-4">
      <div
        className="shrink-0"
        style={{ width: DONUT_SIZE, height: DONUT_SIZE }}
        role="img"
        aria-label={`Who did the work in the last ${days} days: ${summary}`}
      >
        <PieChart width={DONUT_SIZE} height={DONUT_SIZE}>
          <Pie
            data={data}
            dataKey="value"
            nameKey="label"
            cx="50%"
            cy="50%"
            innerRadius={DONUT_SIZE / 2 - DONUT_THICKNESS}
            outerRadius={DONUT_SIZE / 2}
            paddingAngle={data.length > 1 ? 2 : 0}
            stroke="none"
            isAnimationActive={false}
          >
            {data.map((d) => (
              <Cell key={d.key} fill={d.fill} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "var(--panel)",
              border: "1px solid var(--border)",
              borderRadius: 10,
              padding: "6px 8px",
              fontSize: 12,
              color: "var(--fg)",
            }}
            itemStyle={{ color: "var(--fg)" }}
            formatter={(value: unknown, name: unknown) => [
              `${typeof value === "number" ? value.toLocaleString() : String(value)} (${formatShare(
                (typeof value === "number" ? value : 0) / total,
              )})`,
              String(name ?? ""),
            ]}
          />
        </PieChart>
      </div>
      <ul className="min-w-0 space-y-1.5">
        {slices.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2 text-[12px] leading-4">
            <span aria-hidden="true" className="h-2 w-2 shrink-0 rounded-full" style={{ background: sliceColor(s, i) }} />
            <span className="min-w-0 truncate text-[var(--muted)]">{s.label}</span>
            <span className="ml-auto shrink-0 pl-2 tabular-nums font-medium text-[var(--fg)]">{s.count.toLocaleString()}</span>
            <span className="w-9 shrink-0 text-right tabular-nums text-[var(--muted-2)]">{formatShare(s.count / total)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
