/**
 * Who opened this, most recently first — at the top of every metrics page.
 *
 * It is the question the page is opened to answer. "Did the partner I sent it to last night read
 * it?" was previously answered by scrolling past two tiles and two charts to a viewer table sorted
 * by reading time, where the person who arrived ten minutes ago could sit anywhere.
 *
 * So the five most recent visits come first, in time order, and the strip says so out loud when
 * one of them is fresh: a visit inside `FRESH_HOURS` gets the live dot and its time reads in the
 * foreground colour. Older than that and the same rows are quiet history.
 *
 * It renders nothing at all when nobody has visited in the window. A component that says "no
 * recent visitors" above a page whose tiles already say `0` is noise, and the empty state that
 * matters (a document nobody has opened) belongs to the tiles.
 */
"use client";

import Link from "next/link";
import { ClockIcon, FolderIcon, UserIcon } from "@heroicons/react/24/outline";

import DepthBadge, {
  ReadingLegendButton,
} from "@/components/metrics/DepthBadge";

/** Inside this many hours a visit is news, not history. */
const FRESH_HOURS = 6;

export type RecentVisitor = {
  key: string;
  /** A person's name or address, or null for someone who never said who they are. */
  name: string | null;
  lastSeen: string | null;
  /** "3 pages · 2m" — whatever the scope can honestly say about what they did. */
  detail?: string | null;
  /** The raw pair behind the badge, so the row can say Read / Skimmed / Glanced. */
  timeMs?: number | null;
  pages?: number | null;
  /** The document's page count, so one page of nine is not called a read. */
  totalPages?: number | null;
  /** The project this read came through, when it came through one. */
  via?: string | null;
  /** Where that project's own metrics live, so the chip is a way there and not just a label. */
  viaHref?: string | null;
  /** This person's own page. A row without one is a row you cannot click. */
  href?: string | null;
  /** The row's tooltip — what clicking the person will show you. */
  hint?: string | null;
};

/** "just now", "12m ago", "3h ago", "Tue" — short enough to sit in a row. */
function shortAgo(iso: string | null): { label: string; hours: number } | null {
  if (!iso) return null;
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return null;
  const ms = Date.now() - then;
  if (ms < 0) return { label: "just now", hours: 0 };
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return { label: "just now", hours: 0 };
  if (minutes < 60) return { label: `${minutes}m ago`, hours: ms / 3600000 };
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return { label: `${hours}h ago`, hours };
  const days = Math.floor(hours / 24);
  if (days < 7) return { label: `${days}d ago`, hours };
  try {
    return {
      label: new Date(iso).toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      }),
      hours,
    };
  } catch {
    return { label: `${days}d ago`, hours };
  }
}

export default function RecentVisitors({
  visitors,
  limit = 5,
  className,
  onSeeAll,
  seeAllLabel = "See all visitors",
}: {
  visitors: RecentVisitor[];
  limit?: number;
  className?: string;
  /** Takes the reader to the full viewer lists further down the page. */
  onSeeAll?: () => void;
  seeAllLabel?: string;
}) {
  const rows = visitors
    .filter((v) => v.lastSeen)
    .sort(
      (a, b) =>
        new Date(b.lastSeen ?? 0).getTime() -
        new Date(a.lastSeen ?? 0).getTime(),
    )
    .slice(0, limit)
    .map((v) => ({ ...v, ago: shortAgo(v.lastSeen) }))
    .filter((v) => v.ago);

  if (!rows.length) return null;

  const fresh = (rows[0]?.ago?.hours ?? Infinity) <= FRESH_HOURS;

  return (
    <section
      className={[
        "rounded-2xl border bg-[var(--panel)] px-5 py-4",
        // A fresh visit is the one thing on this page worth a second look, so the card says so
        // with its edge rather than with a colour that would compete with the charts.
        // emerald-300 at 40% composites to #c5f5e2 on a white card — 1.20:1, *fainter* than the
        // plain border it replaces, so in light the fresh state was a downgrade. The badge beside
        // it already carries a light value; the edge never got one.
        fresh
          ? "border-emerald-700/40 dark:border-emerald-300/40"
          : "border-[var(--border)]",
        className ?? "",
      ].join(" ")}
    >
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">
          <ClockIcon className="h-3.5 w-3.5" aria-hidden="true" />
          Recent visitors
          {/* The legend lives here rather than on the badges: the words that need explaining are
              inside rows that navigate, and a 10px target inside a link is a mis-click waiting to
              happen. A heading has room, and nothing around it goes anywhere. */}
          <ReadingLegendButton />
        </div>
        {fresh ? (
          <span className="inline-flex items-center gap-1.5 text-[11px] font-semibold text-emerald-600 dark:text-emerald-300">
            <span
              aria-hidden="true"
              className="h-1.5 w-1.5 rounded-full bg-emerald-500 dark:bg-emerald-400"
            />
            {rows[0]?.ago?.label}
          </span>
        ) : null}
      </div>

      <ul className="grid gap-1.5">
        {rows.map((v) => {
          const isFresh = (v.ago?.hours ?? Infinity) <= FRESH_HOURS;
          return (
            /**
             * One row, two destinations, and no nesting.
             *
             * The row used to be a single `<Link>` (or a `<button>` calling `router.push`) wrapping
             * everything, which made the whole row mean one thing: a reader who arrived through a
             * project could only be clicked *to the project*, and the badge and chip inside it were
             * targets that either swallowed the click or followed the row. Clicking anywhere on a
             * person did something other than open that person.
             *
             * Now the person's link covers the row through `after:absolute after:inset-0` — a real
             * anchor, so middle-click and "open in new tab" work — and the project chip is a
             * sibling anchor lifted above that overlay with `relative z-10`. Nothing is inside
             * anything else, so there is no mis-click to get wrong.
             */
            <li
              key={v.key}
              className={[
                "relative -mx-2 flex w-[calc(100%+16px)] items-center gap-3 rounded-lg px-2 py-1 transition-colors",
                v.href ? "hover:bg-[var(--panel-hover)]" : "",
              ].join(" ")}
            >
              <span
                className={[
                  "grid h-7 w-7 shrink-0 place-items-center rounded-full text-[11px] font-semibold",
                  v.name
                    ? "bg-[var(--panel-hover)] text-[var(--fg)]"
                    : "bg-[var(--panel-2)] text-[var(--muted-2)] ring-1 ring-[var(--border)]",
                ].join(" ")}
                aria-hidden="true"
              >
                {v.name ? (
                  v.name.trim().slice(0, 1).toUpperCase()
                ) : (
                  <UserIcon className="h-3.5 w-3.5" />
                )}
              </span>

              <span className="min-w-0 flex-1">
                <span className="flex min-w-0 items-center gap-2">
                  {v.href ? (
                    <Link
                      href={v.href}
                      title={v.hint ?? "See what they read"}
                      className="truncate text-[13px] font-medium text-[var(--fg)] after:absolute after:inset-0 after:content-[''] hover:underline"
                    >
                      {v.name ?? "Anonymous visitor"}
                    </Link>
                  ) : (
                    <span className="truncate text-[13px] font-medium text-[var(--fg)]">
                      {v.name ?? "Anonymous visitor"}
                    </span>
                  )}
                  <DepthBadge
                    timeMs={v.timeMs}
                    pages={v.pages}
                    totalPages={v.totalPages}
                  />
                  {v.via ? (
                    v.viaHref ? (
                      <Link
                        href={v.viaHref}
                        title={`Opened through ${v.via} — see that project's metrics`}
                        className="relative z-10 inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)] transition-colors hover:border-[var(--muted-2)] hover:text-[var(--fg)]"
                      >
                        <FolderIcon
                          className="h-3 w-3 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="truncate">{v.via}</span>
                      </Link>
                    ) : (
                      <span
                        className="inline-flex max-w-[180px] shrink-0 items-center gap-1 rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted)]"
                        title={`Opened through ${v.via}`}
                      >
                        <FolderIcon
                          className="h-3 w-3 shrink-0"
                          aria-hidden="true"
                        />
                        <span className="truncate">{v.via}</span>
                      </span>
                    )
                  ) : null}
                </span>
                {v.detail ? (
                  <span className="block truncate text-[12px] text-[var(--muted-2)]">
                    {v.detail}
                  </span>
                ) : null}
              </span>

              <span
                className={[
                  "shrink-0 whitespace-nowrap text-[12px] tabular-nums",
                  isFresh
                    ? "font-medium text-[var(--fg)]"
                    : "text-[var(--muted-2)]",
                ].join(" ")}
                title={v.lastSeen ?? undefined}
              >
                {v.ago?.label}
              </span>
            </li>
          );
        })}
      </ul>

      {/* Five is the glance; everyone else is in the tables further down, so this jumps there
          rather than making the card grow into a second copy of them. */}
      {onSeeAll && visitors.length > rows.length ? (
        <button
          type="button"
          onClick={onSeeAll}
          className="mt-3 text-[12px] font-medium text-[var(--muted)] underline-offset-4 transition-colors hover:text-[var(--fg)] hover:underline"
        >
          {seeAllLabel} ({visitors.length}) ↓
        </button>
      ) : null}
    </section>
  );
}
