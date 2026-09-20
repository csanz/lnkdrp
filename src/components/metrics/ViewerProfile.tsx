/**
 * One reader's page: everything recorded about how they read this document or project.
 *
 * It began as a drawer, and the drawer told on itself — it opened a second modal for "all 50
 * sessions" and, on a project, drilled into a document inside itself. Nested modals are what a
 * page looks like before anyone builds one.
 *
 * What a page buys, in order of how much it matters: room for the whole story rather than three
 * sections above the fold and the rest behind another click; an address, so "look at what Sequoia
 * actually read" is a link you can paste to a colleague; and a working back button, where Escape
 * used to drop you at the top of a long metrics page.
 *
 * Identity is Pro-gated upstream — this page renders whatever the payload gives it and never
 * re-derives who someone is.
 */
"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon, DocumentTextIcon, UserIcon } from "@heroicons/react/24/outline";

import {
  formatDateTime,
  formatDurationShort,
  formatPageRanges,
  formatShortId,
  parseIsoMs,
  relativeAge,
} from "@/components/metrics/MetricsView";
import DepthBadge, { ReadingLegendButton } from "@/components/metrics/DepthBadge";
import PageReadingDetail from "@/components/metrics/PageReadingDetail";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { REALTIME_STATE_EVENT, realtimeState, subscribeRealtime } from "@/lib/client/realtime";
import { useEntityIdentity } from "@/lib/client/entityIdentity";

/** `u_<userId>` for a signed-in reader, `a_<botIdHash>` for a device. Readable in a URL. */
export function viewerRouteKey(kind: "authed" | "anon", key: string): string {
  return `${kind === "authed" ? "u" : "a"}_${key}`;
}

function parseRouteKey(raw: string): { kind: "authed" | "anon"; key: string } | null {
  const value = decodeURIComponent(raw ?? "").trim();
  if (value.startsWith("u_")) return { kind: "authed", key: value.slice(2) };
  if (value.startsWith("a_")) return { kind: "anon", key: value.slice(2) };
  return null;
}

type Visit = {
  visitId: string;
  startedAt: string | null;
  endedAt?: string | null;
  lastEventAt?: string | null;
  timeSpentMs: number;
  pagesSeen?: number[];
  pageTimeMsByPage?: Record<string, number>;
  /** Project scope: which documents this one tab session touched, longest first. */
  docs?: Array<{ docId: string; title: string | null; timeSpentMs: number; pagesSeen: number[] }>;
};

type ViewerRow = {
  userId?: string;
  botIdHash?: string;
  name?: string | null;
  email?: string | null;
  views?: number;
  timeSpentMs?: number;
  pagesViewed?: number;
  pagesSeen?: number[];
  pageTimeMsByPage?: Record<string, number>;
  sessions?: number;
  docsOpened?: number;
  docs?: Array<{ docId: string; title: string | null; timeSpentMs: number }>;
  openedNothing?: boolean;
  firstSeen?: string | null;
  lastSeen?: string | null;
};

export default function ViewerProfile({
  scopeKind,
  scopeId,
  routeKey,
  days = 15,
}: {
  scopeKind: "doc" | "project";
  scopeId: string;
  routeKey: string;
  days?: number;
}) {
  const who = useMemo(() => parseRouteKey(routeKey), [routeKey]);
  // The document's page count, shared with the header above rather than fetched again.
  const { identity } = useEntityIdentity(scopeKind, scopeId);
  const apiBase = scopeKind === "doc" ? `/api/docs/${encodeURIComponent(scopeId)}` : `/api/projects/${encodeURIComponent(scopeId)}`;
  const backHref = scopeKind === "doc" ? `/doc/${encodeURIComponent(scopeId)}/metrics` : `/project/${encodeURIComponent(scopeId)}/metrics`;

  const [viewer, setViewer] = useState<ViewerRow | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [visitsLoading, setVisitsLoading] = useState(true);
  /** Whether this tab's realtime channel is open — the difference between live and merely loaded. */
  const [connected, setConnected] = useState(false);
  /** When this reader last moved, as told by a `reading` frame. Null until one arrives. */
  const [readingAt, setReadingAt] = useState<number | null>(null);
  /** Re-renders the indicator so "reading now" can lapse without another frame arriving. */
  const [, setTick] = useState(0);

  useEffect(() => {
    const sync = () => setConnected(realtimeState() === "open");
    sync();
    window.addEventListener(REALTIME_STATE_EVENT, sync);
    return () => window.removeEventListener(REALTIME_STATE_EVENT, sync);
  }, []);

  // While someone is reading, the indicator has to be able to go quiet on its own: the last frame
  // is the last thing that will arrive, so nothing else would clear "reading now".
  useEffect(() => {
    if (readingAt === null) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 5_000);
    return () => window.clearInterval(id);
  }, [readingAt]);

  /**
   * A refresh the world asked for keeps what is on screen.
   *
   * This page reloads while you watch it, and the loader used to open by putting it back into its
   * loading state — so every few seconds of someone else's reading blanked six stat tiles, a chart
   * and a session list to skeletons. The figures up are a second stale, not wrong: they stay, and
   * the new ones replace them in place. Same rule the metrics page uses.
   */
  const load = useCallback(async (silent = false) => {
    if (!who) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    if (!silent) setLoading(true);
    try {
      // The same viewers-only read the metrics page makes: one definition of a reader, one query.
      const res = await fetchWithTempUser(`${apiBase}/shareviews?days=${days}&viewers=1&viewersOnly=1`, {
        cache: "no-store",
      });
      if (!res.ok) throw new Error(String(res.status));
      const json = (await res.json()) as { viewers?: ViewerRow[]; anonymousViewers?: ViewerRow[] };
      const row =
        who.kind === "authed"
          ? (json.viewers ?? []).find((v) => String(v.userId ?? "") === who.key)
          : (json.anonymousViewers ?? []).find((v) => String(v.botIdHash ?? "") === who.key);
      // A silent refresh keeps what it has when the answer comes back empty. The row can be
      // missing for reasons that are not "this reader does not exist" — a request that raced a
      // range change, a flaky response, an upstream 402 — and swapping a full page of someone's
      // reading for "No reader by that id in this window" on any of them is a lie told loudly.
      if (row || !silent) {
        setViewer(row ?? null);
        setNotFound(!row);
      }
    } catch {
      if (!silent) setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [apiBase, days, who]);

  useEffect(() => {
    void load();
  }, [load]);

  // Sessions are a document idea: a tab session on a project spans documents, so its page sequence
  // has no project meaning and the documents list below carries what does.
  const loadVisits = useCallback(async (silent = false) => {
    if (!who) return;
    if (!silent) setVisitsLoading(true);
    try {
      const params = new URLSearchParams({ kind: who.kind, limit: "50" });
      params.set(who.kind === "authed" ? "userId" : "botIdHash", who.key);
      // Both scopes answer this now. A project's sessions are grouped across the documents one tab
      // session touched, which is why it has a route of its own rather than a per-document loop.
      const res = await fetchWithTempUser(`${apiBase}/shareviews/visits?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { visits?: Visit[] };
      setVisits(Array.isArray(json.visits) ? json.visits : []);
    } catch {
      // The page still has everything except the session list.
    } finally {
      setVisitsLoading(false);
    }
  }, [apiBase, who]);

  useEffect(() => {
    void loadVisits();
  }, [loadVisits]);

  /**
   * Live, while they are still reading.
   *
   * Three sources, one refresh. `reading` frames are the new one and the point of this page: the
   * server broadcasts one when a reader's visit clock, page clock or page set moves, throttled to
   * a few seconds so a fast page-turner does not become a refetch storm. `viewer` frames cover an
   * arrival and a name given mid-visit. Activity `share.*` rows are the belt to that braces — a
   * download or an unlock also changes what this page says.
   *
   * A `reading` frame is filtered to this person: everyone's reading is broadcast to the
   * workspace, and a page about one reader has no business refetching for another. The comparison
   * is on the bare digest, which is what the frame carries and what this page is addressed by.
   */
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void load(true);
        void loadVisits(true);
      }, 1200);
    };
    // Reconnected: whatever happened while the socket was down never arrived, so start again from
    // the server's truth rather than from what this page happened to have when it lost touch.
    const stopHello = subscribeRealtime("hello", refresh);
    const stopReading = subscribeRealtime("reading", (frame) => {
      if (frame.type !== "reading" || !who) return;
      const mine =
        who.kind === "authed" ? frame.reading.viewerUserId === who.key : frame.reading.viewerKey === who.key;
      if (!mine) return;
      // They are reading *now* — the one fact this page could never show, because it only ever
      // knew when they were last seen at the moment it loaded.
      setReadingAt(Date.now());
      refresh();
    });
    // Identity frames carry no viewer key, so the only filter available is the document — which
    // is still worth applying: every rename anywhere in the workspace used to refetch this page.
    const stopViewer = subscribeRealtime("viewer", (frame) => {
      if (frame.type !== "viewer") return;
      if (scopeKind === "doc" && frame.viewer.docId && frame.viewer.docId !== scopeId) return;
      refresh();
    });
    const stopActivity = subscribeRealtime("activity", (frame) => {
      const type = frame.type === "activity" ? (frame.event?.type ?? "") : "";
      if (type.startsWith("share.")) refresh();
    });
    return () => {
      window.clearTimeout(timer);
      stopHello();
      stopReading();
      stopViewer();
      stopActivity();
    };
  }, [load, loadVisits, who, scopeKind, scopeId]);


  /**
   * No socket, no silence.
   *
   * Realtime was this page's only refresh path, so a deployment without `NEXT_PUBLIC_REALTIME_URL`
   * — or any tab whose connection dropped — sat on the figures it loaded with, for ever, with no
   * way to tell. This is the fallback the rest of the app already carries: poll only while the tab
   * is visible and the channel is not open, at a cadence that is cheap next to the 30-second
   * heartbeat it is chasing.
   */
  useEffect(() => {
    const id = window.setInterval(() => {
      if (realtimeState() === "open") return;
      if (document.visibilityState !== "visible") return;
      void load(true);
      void loadVisits(true);
    }, 20_000);
    return () => window.clearInterval(id);
  }, [load, loadVisits]);

  /**
   * Following one person into one document.
   *
   * A project link writes one row per (viewer, document), and the room's aggregate merges them —
   * which is right for "they opened three documents in nine minutes" and useless for "which pages
   * of the term sheet". `/shareviews/viewer-doc` goes back for the single row that was merged, so
   * this page can answer both questions without pretending a project has page numbers.
   *
   * It is a drill-down rather than a link to the document's own metrics on purpose: a read through
   * a project link belongs to the project, so that person may not appear in the document's own
   * viewer list at all (docs/METRICS.md, `docScope.ts`). Sending someone there would show them an
   * empty page and call it the truth.
   */
  const [openDoc, setOpenDoc] = useState<string | null>(null);
  const [docDetail, setDocDetail] = useState<
    Record<string, { pagesSeen: number[]; pageTimeMsByPage: Record<string, number>; timeSpentMs: number; sessions: number } | "loading">
  >({});

  const openDocDetail = useCallback(
    async (docId: string) => {
      setOpenDoc((cur) => (cur === docId ? null : docId));
      if (docDetail[docId] || !who) return;
      setDocDetail((d) => ({ ...d, [docId]: "loading" }));
      try {
        const params = new URLSearchParams({ docId, days: String(days) });
        params.set(who.kind === "authed" ? "userId" : "botIdHash", who.key);
        const res = await fetchWithTempUser(`${apiBase}/shareviews/viewer-doc?${params.toString()}`, { cache: "no-store" });
        if (!res.ok) throw new Error(String(res.status));
        const json = (await res.json()) as {
          pagesSeen?: number[];
          pageTimeMsByPage?: Record<string, number>;
          timeSpentMs?: number;
          sessions?: number;
        };
        setDocDetail((d) => ({
          ...d,
          [docId]: {
            pagesSeen: Array.isArray(json.pagesSeen) ? json.pagesSeen : [],
            pageTimeMsByPage: json.pageTimeMsByPage ?? {},
            timeSpentMs: typeof json.timeSpentMs === "number" ? json.timeSpentMs : 0,
            sessions: typeof json.sessions === "number" ? json.sessions : 0,
          },
        }));
      } catch {
        setDocDetail((d) => {
          const next = { ...d };
          delete next[docId];
          return next;
        });
      }
    },
    [apiBase, days, docDetail, who],
  );

  const name = (viewer?.name ?? "").trim() || (viewer?.email ?? "").trim();
  const title = name || (who?.kind === "anon" ? "Anonymous visitor" : "Signed-in reader");
  const pagesSeen = useMemo(
    () => (Array.isArray(viewer?.pagesSeen) ? viewer!.pagesSeen!.filter((n) => Number.isFinite(n) && n >= 1).sort((a, b) => a - b) : []),
    [viewer],
  );
  const msByPage = viewer?.pageTimeMsByPage ?? {};
  const pageRows = useMemo(
    () => pagesSeen.map((page) => ({ page, ms: msByPage[String(page)] ?? 0 })).sort((a, b) => b.ms - a.ms || a.page - b.page),
    [pagesSeen, msByPage],
  );
  const timeMs = Math.max(0, viewer?.timeSpentMs ?? 0);
  const sessions = scopeKind === "doc" ? visits.length || viewer?.views || 0 : viewer?.sessions || (viewer?.docs?.length ?? 0);
  const longest = pageRows.find((r) => r.ms > 0) ?? null;
  /**
   * Whether this reader moved inside the last minute.
   *
   * A minute, not five seconds: a reader on a long page writes on a 30-second heartbeat, so a
   * shorter window would blink the indicator off between beats of someone who never stopped
   * reading. The interval above re-renders this so it can lapse by itself.
   */
  const readingNow = readingAt !== null && Date.now() - readingAt < 60_000;

  const stat = (label: string, value: string, sub?: string | null) => (
    <div className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-4">
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--muted-2)]">{label}</div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums text-[var(--fg)]">{value}</div>
      {/* Only the tile whose number is about something nameable uses this: "4m 12s" is the answer,
          but "4m 12s on the term sheet" is the useful one, and a document title does not fit in a
          2xl value slot beside five other tiles. */}
      {sub ? (
        <div className="mt-0.5 truncate text-[12px] text-[var(--muted-2)]" title={sub}>
          {sub}
        </div>
      ) : null}
    </div>
  );

  if (loading) {
    return <div className="text-[13px] text-[var(--muted)]">Loading…</div>;
  }

  if (notFound || !viewer) {
    return (
      <div className="rounded-2xl border border-dashed border-[var(--border)] p-8 text-center text-sm text-[var(--muted)]">
        No reader by that id in this window.{" "}
        <Link href={backHref} className="font-medium text-[var(--fg)] underline underline-offset-4">
          Back to metrics
        </Link>
        .
      </div>
    );
  }

  return (
    <div className="grid gap-6">
      {/* The page is about a person, so the person is the headline — not a row-sized chip above a
          wall of figures. The breadcrumb above already says which document this is. */}
      <div className="flex items-center gap-4">
        <Link
          href={backHref}
          aria-label="Back to metrics"
          className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] transition-colors hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
        >
          <ArrowLeftIcon className="h-4 w-4" />
        </Link>
        <div className="grid h-16 w-16 shrink-0 place-items-center rounded-full border border-[var(--border)] bg-[var(--panel-2)] text-2xl font-semibold text-[var(--fg)]">
          {name ? name.trim()[0]?.toUpperCase() : <UserIcon className="h-8 w-8 text-[var(--muted)]" aria-hidden="true" />}
        </div>
        <div className="min-w-0">
          <div className="flex min-w-0 items-center gap-3">
            <span className="truncate text-3xl font-semibold tracking-tight text-[var(--fg)]">{title}</span>
            <DepthBadge
              timeMs={timeMs}
              pages={scopeKind === "doc" ? viewer.pagesViewed ?? pagesSeen.length : viewer.docs?.length ?? 0}
              totalPages={scopeKind === "doc" ? identity?.pages ?? null : null}
            />
            <ReadingLegendButton />
            {/* Two different claims, and the stronger one wins.
                "Reading now" is about this person: a `reading` frame arrived for them inside the
                last minute, which is as close to watching someone read as a server can get. "Live"
                is only about the connection — this page will update itself when something happens.
                Neither is shown when the channel is down, because a still page that says Live is
                worse than a still page. */}
            {readingNow ? (
              <span
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-emerald-600/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-emerald-700 dark:border-emerald-300/40 dark:text-emerald-300"
                title="A page turn or heartbeat arrived from this reader in the last minute"
              >
                <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500 motion-safe:animate-pulse dark:bg-emerald-400" />
                Reading now
              </span>
            ) : connected ? (
              <span
                className="inline-flex shrink-0 items-center gap-1.5 rounded-full border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--muted)]"
                title="Updates arrive over the realtime connection"
              >
                <span aria-hidden="true" className="inline-block h-1.5 w-1.5 rounded-full bg-[var(--chart-views)]" />
                Live
              </span>
            ) : null}
          </div>
          <div className="mt-1 truncate text-sm text-[var(--muted)]">
            {viewer.email && name !== viewer.email ? `${viewer.email} · ` : ""}
            Last seen {relativeAge(viewer.lastSeen ?? null)}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {stat("Sessions", visitsLoading && !visits.length && scopeKind === "doc" ? "…" : String(sessions || 0))}
        {stat("Time spent", timeMs > 0 ? formatDurationShort(timeMs) : "—")}
        {scopeKind === "doc"
          ? stat("Pages viewed", String(viewer.pagesViewed || pagesSeen.length))
          : stat("Documents", String(viewer.docs?.length ?? 0))}
        {stat(
          scopeKind === "doc" ? "Avg per page" : "Avg per doc",
          (() => {
            const n = scopeKind === "doc" ? viewer.pagesViewed || pagesSeen.length : viewer.docs?.length ?? 0;
            return timeMs > 0 && n > 0 ? formatDurationShort(Math.round(timeMs / n)) : "—";
          })(),
        )}
        {/* A project's unit is documents, not pages.
            "Longest page" was a dead tile on this scope — a project reader's payload carries no
            `pagesSeen` and no `pageTimeMsByPage` at all (their pages belong to whichever document
            they were in, and page 3 of the deck is not page 3 of the term sheet), so it rendered a
            permanent "—". The honest analogue is the document that held them longest, which the
            payload already sorts to the front for us. */}
        {scopeKind === "doc"
          ? stat("Longest page", longest ? `p${longest.page} · ${formatDurationShort(longest.ms)}` : "—")
          : (() => {
              const top = (viewer.docs ?? []).find((d) => (d.timeSpentMs ?? 0) > 0) ?? null;
              return stat(
                "Longest document",
                top ? formatDurationShort(top.timeSpentMs) : "—",
                top ? top.title?.trim() || "Untitled document" : null,
              );
            })()}
        {stat("Avg per session", sessions > 0 && timeMs > 0 ? formatDurationShort(Math.round(timeMs / sessions)) : "—")}
      </div>

      {/* Two columns once the window allows it: the reading shape on the left, the visits on the
          right, instead of a metre of white space beside each. */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] xl:items-start">
      {scopeKind === "doc" ? (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">Time on each page</div>
          <div className="mt-3">
            <PageReadingDetail pagesSeen={pagesSeen} msByPage={msByPage} totalTimeMs={timeMs} />
          </div>
        </section>
      ) : (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">Documents they opened</div>
          {viewer.docs?.length ? (
            <ul className="mt-3 grid gap-1.5">
              {viewer.docs.map((d) => {
                const max = Math.max(1, ...(viewer.docs ?? []).map((x) => x.timeSpentMs));
                const detail = docDetail[d.docId];
                const expanded = openDoc === d.docId;
                return (
                  <li key={d.docId} className="rounded-xl border border-transparent transition-colors data-[open=true]:border-[var(--border)] data-[open=true]:bg-[var(--panel-2)]" data-open={expanded}>
                    <button
                      type="button"
                      onClick={() => void openDocDetail(d.docId)}
                      className="flex w-full items-center gap-3 rounded-xl px-2 py-1.5 text-left transition-colors hover:bg-[var(--panel-hover)]"
                      title="See which pages they read in this document"
                    >
                      <DocumentTextIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                      <span className="min-w-0 flex-1 truncate text-[13px] text-[var(--fg)]">
                        {d.title || "Untitled document"}
                      </span>
                      <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--panel-2)]">
                        <span
                          className="block h-full rounded-full bg-[var(--chart-views)]"
                          style={{ width: `${Math.max(2, Math.round((d.timeSpentMs / max) * 100))}%` }}
                        />
                      </span>
                      <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-[var(--muted)]">
                        {d.timeSpentMs > 0 ? formatDurationShort(d.timeSpentMs) : "—"}
                      </span>
                    </button>

                    {expanded ? (
                      <div className="border-t border-[var(--divider)] px-3 pb-3 pt-2.5">
                        {detail === "loading" || !detail ? (
                          <div className="text-[12px] text-[var(--muted)]">Loading pages…</div>
                        ) : detail.pagesSeen.length ? (
                          <>
                            <div className="text-[12px] text-[var(--muted-2)]">
                              {detail.sessions > 0
                                ? `${detail.sessions} ${detail.sessions === 1 ? "session" : "sessions"} · `
                                : ""}
                              {detail.pagesSeen.length} {detail.pagesSeen.length === 1 ? "page" : "pages"}
                              {detail.timeSpentMs > 0 ? ` · ${formatDurationShort(detail.timeSpentMs)}` : ""}
                            </div>
                            {/* The same component the document side uses: chart and ranked pages,
                                never one without the other. */}
                            <div className="mt-2">
                              <PageReadingDetail
                                pagesSeen={detail.pagesSeen}
                                msByPage={detail.pageTimeMsByPage}
                                totalTimeMs={detail.timeSpentMs}
                              />
                            </div>
                          </>
                        ) : (
                          <div className="text-[12px] text-[var(--muted)]">No pages recorded for this document.</div>
                        )}
                        <div className="mt-2">
                          <Link
                            href={`/doc/${encodeURIComponent(d.docId)}/metrics`}
                            className="text-[12px] font-medium text-[var(--muted)] underline-offset-4 hover:text-[var(--fg)] hover:underline"
                          >
                            This document&apos;s own metrics →
                          </Link>
                        </div>
                      </div>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <div className="mt-2 text-[13px] text-[var(--muted)]">
              {viewer.openedNothing ? "They arrived and opened nothing." : "No documents opened yet."}
            </div>
          )}
        </section>
      )}

      {/* Sessions, on both scopes. On a document a session is a page sequence; on a project it is
          the documents that one sitting touched, which is the sequence that matters there — what
          they opened first, and what they never came back to. */}
      <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="flex items-center justify-between gap-3">
            <div className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">
              Sessions{visits.length ? ` · ${visits.length >= 50 ? "50+" : visits.length}` : ""}
            </div>
            <div className="text-[12px] text-[var(--muted-2)]">Newest first</div>
          </div>
          {visitsLoading && !visits.length ? (
            <div className="mt-2 text-[13px] text-[var(--muted)]">Loading…</div>
          ) : !visits.length ? (
            <div className="mt-2 text-[13px] text-[var(--muted)]">No sessions recorded yet.</div>
          ) : (
            /* Every session, expanded — the page's whole reason for existing over the drawer,
               which could show three and then open another modal for the rest. */
            <ul className="mt-3 grid gap-2">
              {[...visits]
                .sort((a, b) => (parseIsoMs(b.startedAt) ?? 0) - (parseIsoMs(a.startedAt) ?? 0))
                .map((v) => (
                  <li key={v.visitId} className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="text-[13px] text-[var(--fg)]">{formatDateTime(v.startedAt)}</span>
                      <span className="text-[12px] tabular-nums text-[var(--muted)]">
                        {v.timeSpentMs > 0 ? formatDurationShort(v.timeSpentMs) : "—"}
                        {v.docs?.length
                          ? ` · ${v.docs.length} ${v.docs.length === 1 ? "document" : "documents"}`
                          : v.pagesSeen?.length
                            ? ` · ${v.pagesSeen.length === 1 ? "page" : "pages"} ${formatPageRanges(v.pagesSeen)}`
                            : ""}
                      </span>
                    </div>
                    {v.docs?.length ? (
                      // A project session: which documents, longest first.
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {v.docs.map((d) => (
                          <span
                            key={d.docId}
                            className="inline-flex max-w-[220px] items-center gap-1 rounded-md bg-[var(--panel)] px-2 py-0.5 text-[11px] text-[var(--muted)] ring-1 ring-[var(--border)]"
                            title={d.title ?? undefined}
                          >
                            <DocumentTextIcon className="h-3 w-3 shrink-0" aria-hidden="true" />
                            <span className="truncate">{d.title || "Untitled"}</span>
                            <span className="tabular-nums">{d.timeSpentMs > 0 ? formatDurationShort(d.timeSpentMs) : "—"}</span>
                          </span>
                        ))}
                      </div>
                    ) : v.pageTimeMsByPage && Object.keys(v.pageTimeMsByPage).length ? (
                      <div className="mt-2 flex flex-wrap gap-1.5">
                        {Object.entries(v.pageTimeMsByPage)
                          .map(([page, ms]) => ({ page: Number(page), ms: Number(ms) }))
                          .filter((x) => Number.isFinite(x.page) && x.ms > 0)
                          .sort((a, b) => a.page - b.page)
                          .map((x) => (
                            <span
                              key={x.page}
                              className="rounded-md bg-[var(--panel)] px-2 py-0.5 text-[11px] tabular-nums text-[var(--muted)] ring-1 ring-[var(--border)]"
                            >
                              p{x.page} · {formatDurationShort(x.ms)}
                            </span>
                          ))}
                      </div>
                    ) : null}
                  </li>
                ))}
            </ul>
          )}
      </section>
      </div>

      <div className="text-[11px] text-[var(--muted-2)]">
        First seen {formatDateTime(viewer.firstSeen ?? null)}
        {who?.kind === "anon" && who.key ? ` · Device ${formatShortId(who.key)}` : ""}
      </div>
    </div>
  );
}
