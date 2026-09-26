"use client";

/**
 * One contributor's page: everything a person, or an agent they connected, has done here.
 *
 * The feed answers "what happened in this workspace". It could never answer "what has this one
 * done", which is the question an owner actually asks once more than one pair of hands is working
 * - and it became urgent the moment an MCP client could file documents on somebody's behalf, since
 * "Claude Code replaced the deck" in a list of forty rows says nothing about how much of the last
 * week was the agent's.
 *
 * People and agents share this component because they are the same page. A person has an email and
 * a list of the agents they connected; an agent has an owner line back to that person; the dates,
 * the counts, the documents, the projects and the feed underneath mean exactly the same thing for
 * both, and giving each its own component would have meant two of everything below.
 *
 * Deliberately built out of the `/activity` parts rather than beside them: the same shell header,
 * the same tiles as the feed's stats header, the same rows, the same paging rail
 * (`src/components/activity/ActivityRows.tsx`). It is a view of the feed, and it should not read
 * like a different product.
 */

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type SVGProps } from "react";
import { UserIcon } from "@heroicons/react/24/outline";

import AgentMark from "@/components/AgentMark";
import AppPageHeader, { APP_PAGE_GUTTER } from "@/components/AppPageHeader";
import {
  ActivityDayGroups,
  ActivityFeedSkeleton,
  ActivityPager,
  ActivityTypeTabs,
  DEFAULT_ACTIVITY_PAGE_SIZE,
  groupByDay,
} from "@/components/activity/ActivityRows";
import { useActivityPages } from "@/components/activity/useActivityPages";
import { ACTIVITY_FILTERS, type ActivityFilterId } from "@/lib/activity/labels";
import { ACTIVITY_SUMMARY_BUCKETS } from "@/lib/activity/summary";
import { formatRelative } from "@/lib/analytics/reading/format";
import { cn } from "@/lib/cn";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import type { ActorProfile, ActorProfileDoc, ActorProfileProject } from "@/lib/people/types";

/** What the profile request came back as. `missing` is the 404 every unknown key lands on. */
type LoadState = "loading" | "ready" | "missing" | "error";

/** The chip that marks an agent, identical to the one on the donut legend and the contributors card. */
function AgentChip() {
  return (
    <span
      className="shrink-0 rounded px-1 py-px text-[10px] font-semibold uppercase tracking-[0.06em] text-[var(--muted-2)] ring-1 ring-[var(--border)]"
      title="Worked through the MCP, not in the app"
    >
      Agent
    </span>
  );
}

/**
 * One number (or date) and its label, in the `/activity` stats header's shape.
 *
 * The markup is copied from `src/app/(app)/activity/StatsHeader.tsx` rather than imported: that
 * component is a self-fetching 30-day summary of the whole workspace, and there is nothing in it
 * to reuse but the tile. If the tile is restyled, both have to move.
 */
function StatTile({ value, label, title }: { value: string; label: string; title?: string }) {
  return (
    <div className="min-w-0">
      <dd className="text-[20px] font-semibold leading-6 tabular-nums text-[var(--fg)]" title={title}>
        {value}
      </dd>
      <dt className="mt-0.5 text-[11px] leading-4 text-[var(--muted-2)]">{label}</dt>
    </div>
  );
}

/** `3 actions` / `1 action`, the phrasing the stats header and the contributors card both use. */
function actionsLabel(n: number): string {
  return `${n.toLocaleString()} ${n === 1 ? "action" : "actions"}`;
}

/** A card in the right rail, built like the document page's rail cards. */
function RailCard({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
      <div className="mb-3 border-b border-[var(--divider)] pb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
        {title}
      </div>
      <ul className="space-y-2.5">{children}</ul>
    </div>
  );
}

/**
 * One line in a rail card: a name that links where it can, and what was done to it.
 *
 * A deleted document keeps its row. The work happened, and a list that silently drops it would
 * make the totals above disagree with the list below for no reason the reader can see.
 */
function RailRow({
  name,
  href,
  actions,
  lastAt,
  now,
  muted = false,
}: {
  name: string;
  href: string | null;
  actions: number;
  lastAt: string | null;
  now: number;
  /** The thing is gone (a deleted document): struck through, and not a link. */
  muted?: boolean;
}) {
  return (
    <li className="min-w-0">
      {href ? (
        <Link href={href} className="block truncate text-[13px] font-medium text-[var(--fg)] hover:underline underline-offset-4">
          {name}
        </Link>
      ) : (
        <span className={cn("block truncate text-[13px] font-medium text-[var(--fg)]", muted && "line-through")}>
          {name}
        </span>
      )}
      <span className="block truncate text-[11px] leading-4 text-[var(--muted-2)]">
        {actionsLabel(actions)}
        {lastAt && now ? ` · ${formatRelative(lastAt, now)}` : ""}
      </span>
    </li>
  );
}

/** Everything one contributor has done in this workspace, over the feed they did it in. */
export default function ActorPageClient({ actorKey }: { actorKey: string }) {
  const [profile, setProfile] = useState<ActorProfile | null>(null);
  const [state, setState] = useState<LoadState>("loading");
  const [profileError, setProfileError] = useState<string | null>(null);
  // Relative times are pinned to the moment the profile landed, not to each render: reading the
  // clock during render is impure, and a row that ages between renders while its neighbour does
  // not is the visible symptom (same reasoning as `ContributorsCard`).
  const [now, setNow] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setState("loading");
    setProfileError(null);
    void (async () => {
      try {
        const res = await fetchWithTempUser(`/api/activity/actor?key=${encodeURIComponent(actorKey)}`, {
          cache: "no-store",
        });
        if (cancelled) return;
        if (res.status === 404) {
          setProfile(null);
          setState("missing");
          return;
        }
        const json = (await res.json().catch(() => null)) as (ActorProfile & { error?: string }) | null;
        if (cancelled) return;
        if (!res.ok || !json) {
          setProfileError(json?.error ?? "Could not load this contributor.");
          setState("error");
          return;
        }
        setNow(Date.now());
        setProfile(json);
        setState("ready");
      } catch {
        if (!cancelled) {
          setProfileError("Could not load this contributor.");
          setState("error");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [actorKey]);

  const [filter, setFilter] = useState<ActivityFilterId>("all");
  const [pageSize, setPageSize] = useState<number>(DEFAULT_ACTIVITY_PAGE_SIZE);
  const types = useMemo(() => ACTIVITY_FILTERS.find((f) => f.id === filter)?.types ?? [], [filter]);
  const feedRef = useRef<HTMLDivElement | null>(null);
  // The feed is the same endpoint the workspace feed uses, narrowed to this contributor. The
  // who-axis has no meaning here (the actor *is* the who), so it stays "all".
  const { items, freshIds, nextCursor, pageIndex, loading, showSkeleton, pending, leaving, pageKey, error, goToPage } =
    useActivityPages({ filterId: filter, types, who: "all", actor: actorKey, pageSize, scrollRef: feedRef });

  const groups = useMemo(() => groupByDay(items), [items]);
  const isAgent = profile?.kind === "agent";

  /**
   * The mark in the shell's icon slot: the agent's own brand mark where there is one, a person
   * glyph otherwise, so the page identifies itself in the same place every other page does.
   */
  const HeaderIcon = useMemo(() => {
    if (!isAgent || !profile?.client) return UserIcon;
    const client = profile.client;
    return function ActorHeaderIcon({ className }: SVGProps<SVGSVGElement>) {
      return (
        <span aria-hidden="true" className={cn("inline-grid place-items-center", className)}>
          <AgentMark client={client} label={null} className="h-full w-full" />
        </span>
      );
    };
  }, [isAgent, profile?.client]);

  const owner = profile?.owner ?? null;
  const description = (() => {
    // Nothing to describe while it loads, and nothing to add when it is missing: the panel below
    // says that in full, and a header that says it too is the same sentence twice.
    if (!profile) return null;
    if (profile.kind === "person") return profile.email;
    // The owner line: an agent is only meaningful as "this client, connected by this person".
    if (owner?.href && owner.name) {
      return (
        <>
          Connected by{" "}
          <Link href={owner.href} className="underline decoration-dotted underline-offset-4 hover:decoration-solid hover:text-[var(--fg)]">
            {owner.name}
          </Link>
        </>
      );
    }
    if (owner?.href) {
      return (
        <>
          Connected by{" "}
          <Link href={owner.href} className="underline decoration-dotted underline-offset-4 hover:decoration-solid hover:text-[var(--fg)]">
            a member who has left
          </Link>
        </>
      );
    }
    return "Connected by an unknown member";
  })();

  const tiles = useMemo(() => {
    if (!profile) return [];
    const out: Array<{ key: string; value: string; label: string; title?: string }> = [];
    const stamp = (iso: string | null) =>
      iso && now ? { value: formatRelative(iso, now), title: new Date(iso).toLocaleString() } : { value: "–" };
    const first = stamp(profile.firstAt);
    const last = stamp(profile.lastAt);
    out.push({ key: "firstAt", value: first.value, title: first.title, label: "First activity" });
    out.push({ key: "lastAt", value: last.value, title: last.title, label: "Last activity" });
    out.push({ key: "total", value: profile.totalActions.toLocaleString(), label: "Actions" });
    let counted = 0;
    for (const b of ACTIVITY_SUMMARY_BUCKETS) {
      const n = profile.buckets?.[b.id] ?? 0;
      counted += n;
      out.push({ key: b.id, value: n.toLocaleString(), label: b.label });
    }
    // Everything else that counts as work: tagging, project edits, link changes, member events.
    // Without it the tiles would add up to less than "Actions" with nothing to say where the rest
    // went, which reads as a bug rather than as "the buckets are only the headline five".
    const other = Math.max(0, profile.workActions - counted);
    out.push({ key: "other", value: other.toLocaleString(), label: "Other work" });
    return out;
  }, [profile, now]);

  const docs: ActorProfileDoc[] = profile?.docs ?? [];
  const projects: ActorProfileProject[] = profile?.projects ?? [];
  const agents = profile?.agents ?? [];
  const hasRail = docs.length > 0 || projects.length > 0 || agents.length > 0;

  return (
    <div className="flex h-full flex-col">
      <AppPageHeader
        icon={HeaderIcon}
        title={profile?.name ?? (state === "loading" ? "" : "Not found")}
        description={description}
        badge={isAgent ? <AgentChip /> : null}
      >
        <ActivityTypeTabs value={filter} onChange={setFilter} />
      </AppPageHeader>

      <div
        ref={feedRef}
        className={`relative min-h-0 flex-1 overflow-auto bg-[var(--bg)] ${APP_PAGE_GUTTER} py-6`}
        aria-busy={pending || loading}
      >
        {pending ? (
          <div aria-hidden="true" className="pointer-events-none sticky top-0 z-10 -mx-8 -mt-6 mb-4 h-0.5 overflow-hidden bg-transparent">
            <div className="h-full w-1/3 bg-[var(--fg)]/60 motion-safe:animate-[lnkdrpIndeterminate_1.05s_ease-in-out_infinite]" />
          </div>
        ) : null}

        {state === "missing" ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-10 text-center text-sm text-[var(--muted)]">
            No activity for this {actorKey.startsWith("agent:") ? "agent" : "person"} in this workspace.
          </div>
        ) : null}
        {state === "error" ? (
          <div className="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm text-red-700">
            {profileError}
          </div>
        ) : null}

        {state === "ready" && profile ? (
          <>
            {/* The standing summary, in the same tiles as the feed's own header, so the two pages
                agree about what a count of work looks like. Everything here is for all time, not
                the header's 30-day window: this page exists to answer "how much of this was them". */}
            <section aria-label="What this contributor has done" className="mb-6">
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1">
                  <h2 className="text-[11px] font-semibold uppercase tracking-[0.08em] text-[var(--muted-2)]">
                    All time
                  </h2>
                  <span className="text-[11px] tabular-nums text-[var(--muted-2)]">{actionsLabel(profile.totalActions)}</span>
                </div>
                <dl className="mt-3 flex min-w-0 flex-wrap items-start gap-x-7 gap-y-3">
                  {tiles.map((t) => (
                    <StatTile key={t.key} value={t.value} label={t.label} title={t.title} />
                  ))}
                </dl>
                <p className="mt-3 text-[11px] leading-4 text-[var(--muted-2)]">
                  {isAgent
                    ? "What this agent did here. What the member who connected it did in the app is on their own page."
                    : "What this member did in the app. What their agents did is on each agent's page."}
                </p>
              </div>
            </section>

            <div className={hasRail ? "grid gap-6 lg:grid-cols-[minmax(0,1fr)_17rem]" : "grid gap-6"}>
              <div className="min-w-0">
                {error ? (
                  <div className="mb-4 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm text-red-700">
                    {error}
                  </div>
                ) : null}
                {loading ? (
                  showSkeleton ? <ActivityFeedSkeleton /> : null
                ) : !items.length ? (
                  <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-4 py-10 text-center text-sm text-[var(--muted)]">
                    Nothing here under this filter.
                  </div>
                ) : (
                  <div
                    key={pageKey}
                    className={[
                      "grid gap-6 transition-[opacity,transform] duration-200 ease-out motion-reduce:transition-none",
                      leaving ? "translate-y-1 opacity-40" : "translate-y-0 opacity-100",
                    ].join(" ")}
                  >
                    <ActivityDayGroups groups={groups} freshIds={freshIds} />
                    <ActivityPager
                      pageIndex={pageIndex}
                      pageSize={pageSize}
                      onPageSize={setPageSize}
                      nextCursor={nextCursor}
                      itemCount={items.length}
                      loading={loading}
                      pending={pending}
                      onGoToPage={(i) => void goToPage(i)}
                    />
                  </div>
                )}
              </div>

              {hasRail ? (
                <aside className="grid content-start gap-4" aria-label="What they touched">
                  {agents.length ? (
                    <RailCard title="Agents connected">
                      {agents.map((a) => (
                        <RailRow key={a.key} name={a.label} href={a.href} actions={a.actions} lastAt={a.lastAt} now={now} />
                      ))}
                    </RailCard>
                  ) : null}
                  {docs.length ? (
                    <RailCard title="Documents">
                      {docs.map((d) => (
                        <RailRow
                          key={d.id}
                          name={d.title?.trim() || "Untitled document"}
                          href={d.href}
                          actions={d.actions}
                          lastAt={d.lastAt}
                          now={now}
                          muted={d.deleted}
                        />
                      ))}
                    </RailCard>
                  ) : null}
                  {projects.length ? (
                    <RailCard title="Projects">
                      {projects.map((pr) => (
                        <RailRow
                          key={pr.id}
                          name={pr.name?.trim() || "Untitled project"}
                          href={pr.href}
                          actions={pr.actions}
                          lastAt={pr.lastAt}
                          now={now}
                        />
                      ))}
                    </RailCard>
                  ) : null}
                </aside>
              ) : null}
            </div>
          </>
        ) : null}

        {state === "loading" ? (
          <div className="grid gap-6" aria-hidden="true">
            <div className="h-[88px] rounded-2xl border border-[var(--border)] bg-[var(--panel-2)] motion-safe:animate-pulse" />
            <ActivityFeedSkeleton />
          </div>
        ) : null}
      </div>
    </div>
  );
}
