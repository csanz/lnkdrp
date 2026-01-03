/**
 * Client component for owner doc history page.
 * Route: `/doc/:docId/history`
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type DocChangeItem = {
  id: string;
  fromVersion: number | null;
  toVersion: number | null;
  summary: string;
  changes: Array<{ type?: string; title?: string; detail?: string | null }>;
  previousText: string;
  newText: string;
  createdBy: null | { id: string | null; name: string | null; email: string | null };
  createdDate: string | null;
};

function formatRelativeAge(iso: string): string | null {
  const d = new Date(iso);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return null;
  const diffMs = Date.now() - ms;
  if (!Number.isFinite(diffMs)) return null;
  if (diffMs < 30_000) return "just now";

  const minutes = Math.floor(diffMs / 60_000);
  if (minutes <= 0) return "just now";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"} ago`;

  const hours = Math.floor(diffMs / 3_600_000);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;

  const days = Math.floor(diffMs / 86_400_000);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months} month${months === 1 ? "" : "s"} ago`;

  const years = Math.floor(months / 12);
  return `${years} year${years === 1 ? "" : "s"} ago`;
}

function inferImpactLevel(item: { summary: string; changes: Array<{ title?: string; detail?: string | null }> }): {
  label: "None" | "Minor" | "Medium" | "Major";
  tone: "muted" | "ok" | "warn";
} {
  const n = Array.isArray(item.changes) ? item.changes.length : 0;
  const s = (item.summary ?? "").toLowerCase();
  if (n === 0 || s.includes("no meaningful changes") || s.includes("no changes")) return { label: "None", tone: "muted" };
  if (n <= 2) return { label: "Minor", tone: "ok" };
  if (n <= 5) return { label: "Medium", tone: "warn" };
  return { label: "Major", tone: "warn" };
}

function inferTags(item: { summary: string; changes: Array<{ type?: string; title?: string; detail?: string | null }> }): string[] {
  const text = [
    item.summary ?? "",
    ...(Array.isArray(item.changes)
      ? item.changes.flatMap((c) => [
          (c?.type ?? "").toString(),
          (c?.title ?? "").toString(),
          (c?.detail ?? "").toString(),
        ])
      : []),
  ]
    .join("\n")
    .toLowerCase();

  const tags: string[] = [];
  const add = (t: string) => {
    if (!tags.includes(t)) tags.push(t);
  };

  // Prefer explicit agent-provided change types when present.
  for (const c of item.changes ?? []) {
    const t = (c?.type ?? "").toString().trim().toLowerCase();
    if (!t) continue;
    if (t.includes("number") || t.includes("metric")) add("Numbers");
    if (t.includes("team") || t.includes("founder")) add("Team");
    if (t.includes("financial")) add("Financials");
    if (t.includes("ask") || t.includes("fund")) add("Ask");
    if (t.includes("traction") || t.includes("growth")) add("Traction");
  }

  // Keyword-based fallback (best-effort).
  const has = (rx: RegExp) => rx.test(text);
  if (has(/\b(team|founder|hiring|hire|people)\b/)) add("Team");
  if (has(/\b(problem|pain|why now)\b/)) add("Problem");
  if (has(/\b(solution|product|vision|roadmap|features?)\b/)) add("Product");
  if (has(/\b(traction|growth|users|customers|retention|revenue|kpi|metrics?)\b/)) add("Traction");
  if (has(/\b(financial|model|projection|runway|burn|margin)\b/)) add("Financials");
  if (has(/\b(ask|raise|funding|round|terms?)\b/)) add("Ask");
  if (has(/\b(market|tam|sam|som|competition|competitors?)\b/)) add("Market");
  if (has(/\b(gtm|go-to-market|sales|marketing|pricing|distribution)\b/)) add("GTM");

  return tags.slice(0, 3);
}

export default function HistoryPageClient({ docId }: { docId: string }) {
  const [docTitle, setDocTitle] = useState<string>("");
  const [docCurrentVersion, setDocCurrentVersion] = useState<number | null>(null);
  const [items, setItems] = useState<DocChangeItem[]>([]);
  const [loading, setLoading] = useState<boolean>(true);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        const [docRes, changesRes] = await Promise.all([
          fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}`, { cache: "no-store" }),
          fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}/changes`, { cache: "no-store" }),
        ]);

        if (docRes.ok) {
          const json = (await docRes.json()) as unknown;
          const t =
            json &&
            typeof json === "object" &&
            (json as { doc?: unknown }).doc &&
            typeof (json as { doc: { title?: unknown } }).doc.title === "string"
              ? String((json as { doc: { title: string } }).doc.title).trim()
              : "";
          if (!cancelled) setDocTitle(t);
          const v =
            json &&
            typeof json === "object" &&
            (json as { doc?: any }).doc &&
            typeof (json as { doc: { currentUploadVersion?: unknown } }).doc.currentUploadVersion === "number" &&
            Number.isFinite((json as { doc: { currentUploadVersion: number } }).doc.currentUploadVersion)
              ? Number((json as { doc: { currentUploadVersion: number } }).doc.currentUploadVersion)
              : null;
          if (!cancelled) setDocCurrentVersion(v);
        }

        if (changesRes.ok) {
          const json = (await changesRes.json()) as unknown;
          const arr =
            json && typeof json === "object" && Array.isArray((json as any).changes) ? ((json as any).changes as any[]) : [];
          const next: DocChangeItem[] = arr
            .map((c) => ({
              id: typeof c?.id === "string" ? c.id : "",
              fromVersion: typeof c?.fromVersion === "number" && Number.isFinite(c.fromVersion) ? c.fromVersion : null,
              toVersion: typeof c?.toVersion === "number" && Number.isFinite(c.toVersion) ? c.toVersion : null,
              summary: typeof c?.summary === "string" ? c.summary : "",
              changes: Array.isArray(c?.changes) ? c.changes : [],
              previousText: typeof c?.previousText === "string" ? c.previousText : "",
              newText: typeof c?.newText === "string" ? c.newText : "",
              createdBy:
                c?.createdBy && typeof c.createdBy === "object"
                  ? {
                      id: typeof c.createdBy.id === "string" ? c.createdBy.id : null,
                      name: typeof c.createdBy.name === "string" ? c.createdBy.name : null,
                      email: typeof c.createdBy.email === "string" ? c.createdBy.email : null,
                    }
                  : null,
              createdDate: typeof c?.createdDate === "string" ? c.createdDate : null,
            }))
            .filter((c) => Boolean(c.id));
          if (!cancelled) setItems(next);
        } else {
          if (!cancelled) setItems([]);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [docId]);

  const hasHistory = items.length > 0;
  const newestToVersion = useMemo(() => {
    const vs = items.map((x) => x.toVersion).filter((v): v is number => typeof v === "number" && Number.isFinite(v));
    return vs.length ? Math.max(...vs) : null;
  }, [items]);

  const overview = useMemo(() => {
    const replacements = items.length;
    const currentVersion = docCurrentVersion ?? newestToVersion ?? (replacements ? replacements + 1 : null);

    const times = items
      .map((it) => (typeof it.createdDate === "string" ? Date.parse(it.createdDate) : NaN))
      .filter((ms) => Number.isFinite(ms));
    const firstMs = times.length ? Math.min(...times) : null;
    const lastMs = times.length ? Math.max(...times) : null;
    const mostRecent = (function () {
      if (!times.length) return null;
      let best: DocChangeItem | null = null;
      let bestMs = -1;
      for (const it of items) {
        const ms = typeof it.createdDate === "string" ? Date.parse(it.createdDate) : NaN;
        if (!Number.isFinite(ms)) continue;
        if (ms > bestMs) {
          bestMs = ms;
          best = it;
        }
      }
      if (!best || bestMs < 0) return null;
      return { item: best, ms: bestMs };
    })();

    // Avg time between versions (best-effort).
    const sorted = items
      .slice()
      .filter((it) => typeof it.createdDate === "string")
      .sort((a, b) => {
        const av = typeof a.toVersion === "number" ? a.toVersion : 0;
        const bv = typeof b.toVersion === "number" ? b.toVersion : 0;
        if (av !== bv) return av - bv;
        return (a.createdDate ?? "").localeCompare(b.createdDate ?? "");
      });
    const deltas: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const a = Date.parse(sorted[i - 1]?.createdDate ?? "");
      const b = Date.parse(sorted[i]?.createdDate ?? "");
      if (Number.isFinite(a) && Number.isFinite(b) && b >= a) deltas.push(b - a);
    }
    const avgDeltaMs = deltas.length ? Math.round(deltas.reduce((s, x) => s + x, 0) / deltas.length) : null;

    // Top editors
    const byUser = new Map<string, { id: string; name: string | null; email: string | null; count: number }>();
    for (const it of items) {
      const id = it.createdBy?.id ?? null;
      if (!id) continue;
      const prev = byUser.get(id);
      if (prev) {
        prev.count += 1;
      } else {
        byUser.set(id, {
          id,
          name: it.createdBy?.name ?? null,
          email: it.createdBy?.email ?? null,
          count: 1,
        });
      }
    }
    const topEditors = Array.from(byUser.values()).sort((a, b) => b.count - a.count).slice(0, 5);

    // Impact breakdown + tag counts (reuse existing heuristics).
    const impactCounts = { None: 0, Minor: 0, Medium: 0, Major: 0 } as Record<string, number>;
    const tagCounts = new Map<string, number>();
    for (const it of items) {
      const impact = inferImpactLevel({ summary: it.summary, changes: it.changes });
      impactCounts[impact.label] = (impactCounts[impact.label] ?? 0) + 1;
      for (const t of inferTags({ summary: it.summary, changes: it.changes })) {
        tagCounts.set(t, (tagCounts.get(t) ?? 0) + 1);
      }
    }
    const topTags = Array.from(tagCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([tag, count]) => ({ tag, count }));

    return {
      replacements,
      currentVersion,
      firstMs,
      lastMs,
      mostRecent,
      avgDeltaMs,
      topEditors,
      impactCounts,
      topTags,
    };
  }, [items, docCurrentVersion, newestToVersion]);

  function formatDuration(ms: number): string {
    const minutes = Math.floor(ms / 60_000);
    if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
    const hours = Math.floor(ms / 3_600_000);
    if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"}`;
    const days = Math.floor(ms / 86_400_000);
    if (days < 60) return `${days} day${days === 1 ? "" : "s"}`;
    const months = Math.floor(days / 30);
    if (months < 24) return `${months} month${months === 1 ? "" : "s"}`;
    const years = Math.floor(months / 12);
    return `${years} year${years === 1 ? "" : "s"}`;
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center gap-3 border-b border-[var(--border)] bg-[var(--panel)] px-6 py-4">
        <Link
          href={`/doc/${encodeURIComponent(docId)}`}
          className="inline-flex h-9 w-9 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
          aria-label="Back to document"
          title="Back to document"
        >
          <ArrowLeftIcon className="h-5 w-5" />
        </Link>

        <div className="min-w-0">
          <div className="truncate text-sm font-semibold text-[var(--fg)]">{docTitle || "Document"}</div>
          <div className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
            <Link href={`/doc/${encodeURIComponent(docId)}`} className="hover:underline underline-offset-4">
              Document
            </Link>
            <span aria-hidden="true">›</span>
            <span className="font-medium text-[var(--fg)]">History</span>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)]">
        <div className="mx-auto w-full max-w-[1700px] px-6 py-6">
          <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1fr_440px]">
            {/* Left: history list */}
            <div className="min-w-0">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)]">
                <div className="flex items-center justify-between gap-4 border-b border-[var(--border)] px-5 py-4">
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-[var(--fg)]">Version history</div>
                    <div className="mt-0.5 text-xs text-[var(--muted)]">
                      {loading
                        ? "Loading…"
                        : hasHistory
                          ? `Showing ${items.length} change ${items.length === 1 ? "record" : "records"}`
                          : "No replacement history yet"}
                    </div>
                  </div>
                  {newestToVersion ? (
                    <div className="shrink-0 rounded-md bg-[var(--panel-hover)] px-2 py-1 text-[11px] font-medium text-[var(--muted-2)]">
                      Latest: v{newestToVersion}
                    </div>
                  ) : null}
                </div>

                <div className="px-5 py-4" id="versions">
                  {!loading && !hasHistory ? (
                    <div className="text-sm text-[var(--muted)]">
                      Replace the file to generate a version change summary.
                    </div>
                  ) : null}

                  <div className="space-y-4">
                    {items.map((it) => {
                      const toV = it.toVersion;
                      const fromV = it.fromVersion;
                      const anchorId = toV ? `v-${toV}` : it.id;
                      const impact = inferImpactLevel({ summary: it.summary, changes: it.changes });
                      const tags = inferTags({ summary: it.summary, changes: it.changes });
                      const uploaderLabel = it.createdBy?.name ?? it.createdBy?.email ?? null;
                      const timeLabel = it.createdDate ? formatRelativeAge(it.createdDate) : null;
                      const absoluteLabel = it.createdDate
                        ? (() => {
                            try {
                              return new Date(it.createdDate ?? "").toLocaleString();
                            } catch {
                              return it.createdDate ?? "";
                            }
                          })()
                        : null;
                      return (
                        <div key={it.id} id={anchorId} className="rounded-lg border border-[var(--border)] bg-[var(--bg)]">
                          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
                            <div className="flex flex-wrap items-center gap-2">
                              <span className="text-sm font-semibold text-[var(--fg)]">
                                {toV ? `v${toV}` : "Version"}
                              </span>
                              {fromV && toV ? (
                                <span className="text-xs text-[var(--muted)]">from v{fromV} → v{toV}</span>
                              ) : null}
                            </div>
                            <div className="flex items-center gap-2">
                              <span
                                className={[
                                  "rounded-md px-2 py-0.5 text-[11px] font-medium",
                                  impact.tone === "muted"
                                    ? "bg-[var(--panel-hover)] text-[var(--muted-2)]"
                                    : impact.tone === "ok"
                                      ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-0"
                                      : "bg-amber-50 text-amber-800 ring-1 ring-inset ring-amber-200 dark:bg-amber-500/10 dark:text-amber-300 dark:ring-0",
                                ].join(" ")}
                                title="Best-effort impact estimate (derived from change list)"
                              >
                                {impact.label}
                              </span>
                            </div>
                          </div>

                          <div className="px-4 py-4">
                            {(uploaderLabel || timeLabel) ? (
                              <div className="mb-3 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[var(--muted)]">
                                {uploaderLabel ? (
                                  <span>
                                    by{" "}
                                    <span className="font-medium text-[var(--fg)]">
                                      {uploaderLabel}
                                    </span>
                                  </span>
                                ) : null}
                                {timeLabel ? (
                                  <span title={absoluteLabel ?? undefined}>
                                    updated{" "}
                                    <span className="font-medium text-[var(--fg)]">{timeLabel}</span>
                                  </span>
                                ) : null}
                                {tags.length ? (
                                  <span className="flex flex-wrap items-center gap-1.5">
                                    {tags.map((t) => (
                                      <span
                                        key={t}
                                        className="rounded-md bg-[var(--panel-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted-2)]"
                                      >
                                        {t}
                                      </span>
                                    ))}
                                  </span>
                                ) : null}
                              </div>
                            ) : null}

                            <div className="text-sm leading-relaxed text-[var(--fg)]">
                              {it.summary?.trim() ? it.summary.trim() : "Change summary unavailable."}
                            </div>

                            {Array.isArray(it.changes) && it.changes.length ? (
                              <ul className="mt-4 list-disc space-y-1.5 pl-5 text-sm text-[var(--muted)]">
                                {it.changes.map((c, idx) => (
                                  <li key={idx}>
                                    <span className="font-medium text-[var(--fg)]">{(c?.title ?? "").toString()}</span>
                                    {c?.detail ? (
                                      <span className="text-[var(--muted)]"> — {String(c.detail)}</span>
                                    ) : null}
                                  </li>
                                ))}
                              </ul>
                            ) : null}

                            <div className="mt-4 flex flex-wrap items-center gap-2">
                              <button
                                type="button"
                                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
                                onClick={() => {
                                  const text = (it.summary ?? "").toString().trim();
                                  if (!text) return;
                                  void navigator.clipboard?.writeText(text);
                                }}
                                title="Copy summary"
                              >
                                Copy summary
                              </button>
                            </div>

                            <details className="mt-4">
                              <summary className="cursor-pointer select-none text-xs font-medium text-[var(--muted)] hover:text-[var(--fg)]">
                                View extracted text (previous vs new)
                              </summary>
                              <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-2">
                                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
                                  <div className="text-xs font-semibold text-[var(--fg)]">Previous</div>
                                  <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--muted)]">
                                    {it.previousText || "(empty)"}
                                  </pre>
                                </div>
                                <div className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
                                  <div className="text-xs font-semibold text-[var(--fg)]">New</div>
                                  <pre className="mt-2 max-h-[360px] overflow-auto whitespace-pre-wrap break-words text-xs text-[var(--muted)]">
                                    {it.newText || "(empty)"}
                                  </pre>
                                </div>
                              </div>
                            </details>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            </div>

            {/* Right: full-page sidebar */}
            <div className="min-w-0">
              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4 xl:sticky xl:top-6">
                <div className="text-sm font-semibold text-[var(--fg)]">History overview</div>
                <div className="mt-0.5 text-xs text-[var(--muted)]">Aggregate stats (best-effort)</div>

                <div className="mt-3 space-y-2 text-xs text-[var(--muted)]">
                  <div className="flex items-center justify-between gap-2">
                    <span>Current version</span>
                    <span className="font-medium text-[var(--fg)]">
                      {overview.currentVersion ? `v${overview.currentVersion}` : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>Replacements</span>
                    <span className="font-medium text-[var(--fg)]">{overview.replacements}</span>
                  </div>
                  {overview.mostRecent?.item?.createdBy ? (
                    <div className="flex items-center justify-between gap-2">
                      <span>Most recent editor</span>
                      <span className="min-w-0 truncate font-medium text-[var(--fg)]">
                        {overview.mostRecent.item.createdBy?.name ??
                          overview.mostRecent.item.createdBy?.email ??
                          "Unknown"}
                      </span>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-2">
                    <span>First change</span>
                    <span className="font-medium text-[var(--fg)]">
                      {overview.firstMs ? new Date(overview.firstMs).toLocaleDateString() : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>Last change</span>
                    <span className="font-medium text-[var(--fg)]">
                      {overview.lastMs ? new Date(overview.lastMs).toLocaleDateString() : "—"}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-2">
                    <span>Avg cadence</span>
                    <span className="font-medium text-[var(--fg)]">
                      {overview.avgDeltaMs ? formatDuration(overview.avgDeltaMs) : "— (needs 2+ changes)"}
                    </span>
                  </div>
                </div>

                {overview.topEditors.length ? (
                  <div className="mt-4">
                    <div className="text-xs font-semibold text-[var(--fg)]">Top editors</div>
                    <div className="mt-2 space-y-1 text-xs text-[var(--muted)]">
                      {overview.topEditors.map((u) => (
                        <div key={u.id} className="flex items-center justify-between gap-2">
                          <span className="min-w-0 truncate" title={u.email ?? undefined}>
                            <span className="font-medium text-[var(--fg)]">
                              {u.name ?? u.email ?? "Unknown"}
                            </span>
                          </span>
                          <span className="shrink-0 font-medium text-[var(--fg)]">{u.count}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {overview.replacements ? (
                  <div className="mt-4">
                    <div className="text-xs font-semibold text-[var(--fg)]">Impact breakdown</div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-[var(--muted)]">
                      {(["None", "Minor", "Medium", "Major"] as const).map((k) => (
                        <div key={k} className="flex items-center justify-between gap-2 rounded-md bg-[var(--bg)] px-2 py-1">
                          <span>{k}</span>
                          <span className="font-medium text-[var(--fg)]">{overview.impactCounts[k] ?? 0}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {overview.topTags.length ? (
                  <div className="mt-4">
                    <div className="text-xs font-semibold text-[var(--fg)]">Common signals</div>
                    <div className="mt-2 flex flex-wrap gap-1.5">
                      {overview.topTags.map((t) => (
                        <span
                          key={t.tag}
                          className="rounded-md bg-[var(--panel-hover)] px-2 py-0.5 text-[11px] font-medium text-[var(--muted-2)]"
                          title={`${t.count} version${t.count === 1 ? "" : "s"}`}
                        >
                          {t.tag}
                        </span>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}


