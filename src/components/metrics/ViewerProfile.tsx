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
  PageTimeChart,
  formatDateTime,
  formatDurationShort,
  formatPageRanges,
  formatShortId,
  parseIsoMs,
  relativeAge,
} from "@/components/metrics/MetricsView";
import DepthBadge from "@/components/metrics/DepthBadge";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import { subscribeRealtime } from "@/lib/client/realtime";
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
  endedAt: string | null;
  timeSpentMs: number;
  pagesSeen?: number[];
  pageTimeMsByPage?: Record<string, number>;
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
  const [visitsLoading, setVisitsLoading] = useState(scopeKind === "doc");

  const load = useCallback(async () => {
    if (!who) {
      setNotFound(true);
      setLoading(false);
      return;
    }
    setLoading(true);
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
      setViewer(row ?? null);
      setNotFound(!row);
    } catch {
      setNotFound(true);
    } finally {
      setLoading(false);
    }
  }, [apiBase, days, who]);

  useEffect(() => {
    void load();
  }, [load]);

  // Sessions are a document idea: a tab session on a project spans documents, so its page sequence
  // has no project meaning and the documents list below carries what does.
  const loadVisits = useCallback(async () => {
    if (scopeKind !== "doc" || !who) return;
    setVisitsLoading(true);
    try {
      const params = new URLSearchParams({ kind: who.kind, limit: "50" });
      params.set(who.kind === "authed" ? "userId" : "botIdHash", who.key);
      const res = await fetchWithTempUser(`${apiBase}/shareviews/visits?${params.toString()}`, { cache: "no-store" });
      if (!res.ok) return;
      const json = (await res.json()) as { visits?: Visit[] };
      setVisits(Array.isArray(json.visits) ? json.visits : []);
    } catch {
      // The page still has everything except the session list.
    } finally {
      setVisitsLoading(false);
    }
  }, [apiBase, scopeKind, who]);

  useEffect(() => {
    void loadVisits();
  }, [loadVisits]);

  /**
   * Live, while they are still reading.
   *
   * The share-view and project-link-view change streams both broadcast `viewer` frames, and a
   * recipient who introduces themselves mid-visit broadcasts one too — so the same subscription
   * covers "they turned three more pages" and "the anonymous device now has a name". Debounced,
   * because a fast reader produces a frame per page and this page makes two requests per refresh.
   */
  useEffect(() => {
    let timer: number | undefined;
    const refresh = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        void load();
        void loadVisits();
      }, 1200);
    };
    const stopViewer = subscribeRealtime("viewer", refresh);
    const stopActivity = subscribeRealtime("activity", (frame) => {
      const type = frame.type === "activity" ? (frame.event?.type ?? "") : "";
      if (type.startsWith("share.")) refresh();
    });
    return () => {
      window.clearTimeout(timer);
      stopViewer();
      stopActivity();
    };
  }, [load, loadVisits]);


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
  const hasPerPageTime = pageRows.some((r) => r.ms > 0);
  const maxPageMs = Math.max(1, ...pageRows.map((r) => r.ms));
  const timeMs = Math.max(0, viewer?.timeSpentMs ?? 0);
  const sessions = scopeKind === "doc" ? visits.length || viewer?.views || 0 : viewer?.sessions || (viewer?.docs?.length ?? 0);
  const longest = pageRows.find((r) => r.ms > 0) ?? null;

  const stat = (label: string, value: string) => (
    <div className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-4">
      <div className="truncate text-[11px] font-medium uppercase tracking-[0.1em] text-[var(--muted-2)]">{label}</div>
      <div className="mt-1 truncate text-2xl font-semibold tabular-nums text-[var(--fg)]">{value}</div>
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
        {stat("Longest page", longest ? `p${longest.page} · ${formatDurationShort(longest.ms)}` : "—")}
        {stat("Avg per session", sessions > 0 && timeMs > 0 ? formatDurationShort(Math.round(timeMs / sessions)) : "—")}
      </div>

      {/* Two columns once the window allows it: the reading shape on the left, the visits on the
          right, instead of a metre of white space beside each. */}
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] xl:items-start">
      {scopeKind === "doc" ? (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">Time on each page</div>
          {hasPerPageTime ? (
            <>
              <div className="mt-3">
                <PageTimeChart pages={pagesSeen} msByPage={msByPage} />
              </div>
              {/* The chart says they slowed down somewhere; the list says where. */}
              <ul className="mt-4 grid gap-1.5 border-t border-[var(--divider)] pt-4">
                {pageRows.map((row) => (
                  <li key={row.page} className="flex items-center gap-3">
                    <span className="w-14 shrink-0 text-[12px] tabular-nums text-[var(--muted)]">Page {row.page}</span>
                    <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--panel-2)]">
                      <span
                        className="block h-full rounded-full bg-emerald-500/70"
                        style={{ width: `${Math.max(2, Math.round((row.ms / maxPageMs) * 100))}%` }}
                      />
                    </span>
                    <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-[var(--fg)]">
                      {row.ms > 0 ? formatDurationShort(row.ms) : "—"}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : pagesSeen.length ? (
            <div className="mt-2 text-[13px] text-[var(--muted)]">
              Opened {pagesSeen.length === 1 ? "page" : "pages"} {formatPageRanges(pagesSeen)}
              {timeMs > 0 ? `, ${formatDurationShort(timeMs)} in total.` : "."} Time per page wasn&apos;t recorded for this
              reader.
            </div>
          ) : (
            <div className="mt-2 text-[13px] text-[var(--muted)]">No page activity recorded yet.</div>
          )}
        </section>
      ) : (
        <section className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
          <div className="text-[13px] font-semibold uppercase tracking-[0.1em] text-[var(--muted-2)]">Documents they opened</div>
          {viewer.docs?.length ? (
            <ul className="mt-3 grid gap-1.5">
              {viewer.docs.map((d) => {
                const max = Math.max(1, ...(viewer.docs ?? []).map((x) => x.timeSpentMs));
                return (
                  <li key={d.docId} className="flex items-center gap-3">
                    <DocumentTextIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                    <Link
                      href={`/doc/${encodeURIComponent(d.docId)}/metrics`}
                      className="min-w-0 flex-1 truncate text-[13px] text-[var(--fg)] hover:underline underline-offset-4"
                    >
                      {d.title || "Untitled document"}
                    </Link>
                    <span className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-[var(--panel-2)]">
                      <span
                        className="block h-full rounded-full bg-emerald-500/70"
                        style={{ width: `${Math.max(2, Math.round((d.timeSpentMs / max) * 100))}%` }}
                      />
                    </span>
                    <span className="w-16 shrink-0 text-right text-[12px] tabular-nums text-[var(--muted)]">
                      {d.timeSpentMs > 0 ? formatDurationShort(d.timeSpentMs) : "—"}
                    </span>
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

      {scopeKind === "doc" ? (
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
                        {v.pagesSeen?.length ? ` · ${v.pagesSeen.length === 1 ? "page" : "pages"} ${formatPageRanges(v.pagesSeen)}` : ""}
                      </span>
                    </div>
                    {v.pageTimeMsByPage && Object.keys(v.pageTimeMsByPage).length ? (
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
      ) : null}
      </div>

      <div className="text-[11px] text-[var(--muted-2)]">
        First seen {formatDateTime(viewer.firstSeen ?? null)}
        {who?.kind === "anon" && who.key ? ` · Device ${formatShortId(who.key)}` : ""}
      </div>
    </div>
  );
}
