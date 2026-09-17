/**
 * Key facts for one person: link, first and last seen, visits, total time, pages reached, downloads.
 */
import { formatDwell, formatRelative } from "@/lib/analytics/reading/format";
import type { PersonResponse } from "@/lib/analytics/reading/types";

/** "Sep 10, 1:42 PM" in the viewer's time zone; "—" when unparseable. */
export function formatDateTimeShort(iso: string): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "—";
  return new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function Fact({ label, children, title }: { label: string; children: React.ReactNode; title?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">{label}</dt>
      <dd className="mt-1 truncate text-sm font-semibold text-[var(--fg)]" title={title}>
        {children}
      </dd>
    </div>
  );
}

/** Two columns under 640px, four from 640px. */
export default function ReaderFacts({ data, now }: { data: PersonResponse; now: number }) {
  const { person, facts, pageCount } = data;
  return (
    <dl className="grid grid-cols-2 gap-x-4 gap-y-4 sm:grid-cols-4" data-reader-facts>
      <Fact label="Link" title={person.linkLabel}>
        <span className="inline-flex max-w-full items-center gap-1.5">
          <span className="truncate">{person.linkLabel}</span>
          {person.isDefaultLink ? (
            <span className="shrink-0 rounded-full border border-[var(--border)] px-1.5 py-px text-[10px] font-semibold text-[var(--muted-2)]">
              Default
            </span>
          ) : null}
        </span>
      </Fact>
      <Fact label="First seen">{formatDateTimeShort(person.firstSeen)}</Fact>
      <Fact label="Last seen" title={formatDateTimeShort(person.lastSeen)}>
        {formatRelative(person.lastSeen, now)}
      </Fact>
      <Fact label="Visits">{String(facts.visits)}</Fact>
      <Fact label="Total time">{formatDwell(facts.totalMs)}</Fact>
      <Fact label="Pages reached">{`${facts.reachedCount} of ${pageCount}`}</Fact>
      {person.downloads > 0 ? <Fact label="Downloads">{String(person.downloads)}</Fact> : null}
    </dl>
  );
}
