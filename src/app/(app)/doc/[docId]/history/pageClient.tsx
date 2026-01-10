/**
 * Client component for owner doc history page.
 * Route: `/doc/:docId/history`
 */
"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { ArrowLeftIcon } from "@heroicons/react/24/outline";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";
import Modal from "@/components/modals/Modal";
import { dispatchOutOfCredits } from "@/lib/client/outOfCredits";

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
  // Precomputed derived fields to keep render fast (History can have many records).
  impact: { label: "None" | "Minor" | "Medium" | "Major"; tone: "muted" | "ok" | "warn" };
  tags: string[];
  timeLabel: string | null;
};

type RecipientRow = { userId: string; name: string | null; email: string | null; opened: boolean };

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
  // Fast-path: if types already gave us enough signal, skip all regex work.
  if (tags.length >= 3) return tags.slice(0, 3);

  // Keyword-based fallback (best-effort).
  // Perf: keep this extremely cheap:
  // - do NOT include long `detail` fields
  // - cap total text length
  const MAX_CHARS = 2200;
  const parts: string[] = [];
  const summary = (item.summary ?? "").toString();
  if (summary) parts.push(summary);
  const ch = Array.isArray(item.changes) ? item.changes : [];
  for (let i = 0; i < ch.length && parts.join("\n").length < MAX_CHARS; i++) {
    const c = ch[i];
    const type = (c?.type ?? "").toString();
    const title = (c?.title ?? "").toString();
    // Intentionally skip `detail` (can be huge and slows down lowercasing/regex).
    const line = `${type}\n${title}`.trim();
    if (line) parts.push(line);
  }
  const text = parts.join("\n").slice(0, MAX_CHARS).toLowerCase();

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
  const [recipientsByVersion, setRecipientsByVersion] = useState<Record<string, RecipientRow[]>>({});
  const [recipientsLoadingByVersion, setRecipientsLoadingByVersion] = useState<Record<string, boolean>>({});
  const [viewerStatsOpen, setViewerStatsOpen] = useState<null | { version: number; userId: string; name: string | null; email: string | null }>(null);
  const [viewerStats, setViewerStats] = useState<any>(null);
  const [viewerStatsLoading, setViewerStatsLoading] = useState(false);
  const [viewerStatsError, setViewerStatsError] = useState<string | null>(null);
  const [rerunTierById, setRerunTierById] = useState<Record<string, "basic" | "standard" | "advanced">>({});
  const [defaultHistoryTier, setDefaultHistoryTier] = useState<"basic" | "standard" | "advanced">("standard");
  const [rerunBusyById, setRerunBusyById] = useState<Record<string, boolean>>({});
  const [rerunErrorById, setRerunErrorById] = useState<Record<string, string>>({});

  // Load workspace defaults (best-effort). Falls back to "standard".
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const res = await fetch("/api/credits/quality-defaults", { method: "GET" });
        const json = (await res.json().catch(() => null)) as any;
        if (!res.ok) return;
        if (!json || json.ok !== true) return;
        const t = typeof json.history === "string" ? json.history : "";
        if (!cancelled && (t === "basic" || t === "standard" || t === "advanced")) setDefaultHistoryTier(t);
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  async function refresh() {
    const changesRes = await fetchWithTempUser(`/api/docs/${encodeURIComponent(docId)}/changes?noText=1`, { cache: "no-store" });

    if (changesRes.ok) {
      const json = (await changesRes.json()) as any;
      const t = typeof json?.docTitle === "string" ? json.docTitle.trim() : "";
      if (t) setDocTitle(t);
      const v = typeof json?.currentUploadVersion === "number" && Number.isFinite(json.currentUploadVersion) ? json.currentUploadVersion : null;
      setDocCurrentVersion(v);
      const arr = json && typeof json === "object" && Array.isArray((json as any).changes) ? ((json as any).changes as any[]) : [];
      const next: DocChangeItem[] = arr
        .map((c) => {
          const id = typeof c?.id === "string" ? c.id : "";
          const summary = typeof c?.summary === "string" ? c.summary : "";
          const changes = Array.isArray(c?.changes) ? c.changes : [];
          const createdDate = typeof c?.createdDate === "string" ? c.createdDate : null;
          const impact = inferImpactLevel({ summary, changes });
          const tags = inferTags({ summary, changes });
          const timeLabel = createdDate ? formatRelativeAge(createdDate) : null;
          return {
            id,
            fromVersion: typeof c?.fromVersion === "number" && Number.isFinite(c.fromVersion) ? c.fromVersion : null,
            toVersion: typeof c?.toVersion === "number" && Number.isFinite(c.toVersion) ? c.toVersion : null,
            summary,
            changes,
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
            createdDate,
            impact,
            tags,
            timeLabel,
          } satisfies DocChangeItem;
        })
        .filter((c) => Boolean(c.id));
      setItems(next);
    } else {
      setItems([]);
    }
  }

  async function ensureChangeText(changeId: string) {
    const id = (changeId ?? "").toString().trim();
    if (!id) return;
    // Already loaded?
    const existing = items.find((x) => x.id === id);
    if (!existing) return;
    if (existing.previousText || existing.newText) return;

    try {
      const res = await fetchWithTempUser(
        `/api/docs/${encodeURIComponent(docId)}/changes/${encodeURIComponent(id)}`,
        { cache: "no-store" },
      );
      if (!res.ok) return;
      const json = (await res.json().catch(() => null)) as any;
      const c = json && typeof json === "object" ? (json as any).change : null;
      const prevText = typeof c?.previousText === "string" ? c.previousText : "";
      const newText = typeof c?.newText === "string" ? c.newText : "";
      setItems((prev) =>
        prev.map((it) => (it.id === id ? { ...it, previousText: prevText, newText } : it)),
      );
    } catch {
      // ignore; best-effort
    }
  }

  useEffect(() => {
    let cancelled = false;
    async function load() {
      setLoading(true);
      try {
        await refresh();
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

    // Impact breakdown + tag counts (reuse precomputed fields to keep this fast).
    const impactCounts = { None: 0, Minor: 0, Medium: 0, Major: 0 } as Record<string, number>;
    const tagCounts = new Map<string, number>();
    for (const it of items) {
      impactCounts[it.impact.label] = (impactCounts[it.impact.label] ?? 0) + 1;
      for (const t of it.tags) {
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

  async function ensureRecipients(version: number) {
    const key = String(version);
    if (recipientsByVersion[key]) return;
    if (recipientsLoadingByVersion[key]) return;
    setRecipientsLoadingByVersion((m) => ({ ...m, [key]: true }));
    try {
      const res = await fetchWithTempUser(
        `/api/docs/${encodeURIComponent(docId)}/history/${encodeURIComponent(String(version))}/recipients`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error("Failed to load recipients");
      const json = (await res.json()) as any;
      const rows = Array.isArray(json?.recipients) ? (json.recipients as any[]) : [];
      const parsed: RecipientRow[] = rows
        .map((r) => ({
          userId: typeof r?.userId === "string" ? r.userId : "",
          name: typeof r?.name === "string" ? r.name : null,
          email: typeof r?.email === "string" ? r.email : null,
          opened: Boolean(r?.opened),
        }))
        .filter((r) => Boolean(r.userId));
      setRecipientsByVersion((m) => ({ ...m, [key]: parsed }));
    } catch {
      // ignore; best-effort
    } finally {
      setRecipientsLoadingByVersion((m) => ({ ...m, [key]: false }));
    }
  }

  async function openViewerStats(params: { version: number; userId: string; name: string | null; email: string | null }) {
    setViewerStatsOpen(params);
    setViewerStats(null);
    setViewerStatsError(null);
    setViewerStatsLoading(true);
    try {
      const res = await fetchWithTempUser(
        `/api/docs/${encodeURIComponent(docId)}/history/${encodeURIComponent(String(params.version))}/viewer/${encodeURIComponent(params.userId)}`,
        { cache: "no-store" },
      );
      if (!res.ok) throw new Error("Failed to load viewer stats");
      const json = (await res.json()) as any;
      setViewerStats(json);
    } catch (e) {
      setViewerStatsError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setViewerStatsLoading(false);
    }
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
                      const impact = it.impact;
                      const tags = it.tags;
                      const uploaderLabel = it.createdBy?.name ?? it.createdBy?.email ?? null;
                      const timeLabel = it.timeLabel;
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

                              <select
                                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
                                value={rerunTierById[it.id] ?? defaultHistoryTier}
                                onChange={(e) =>
                                  setRerunTierById((m) => ({ ...m, [it.id]: e.target.value as any }))
                                }
                                aria-label="History quality"
                                title="Choose quality for history regeneration"
                              >
                                <option value="basic">Basic (2 credits)</option>
                                <option value="standard">Standard (5 credits)</option>
                                <option value="advanced">Advanced (12 credits)</option>
                              </select>
                              <button
                                type="button"
                                className="rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-1 text-[11px] font-medium text-[var(--muted)] hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] disabled:opacity-60"
                                disabled={Boolean(rerunBusyById[it.id])}
                                onClick={() => {
                                  void (async () => {
                                    const tier = rerunTierById[it.id] ?? "standard";
                                    const idKey =
                                      typeof crypto !== "undefined" && "randomUUID" in crypto
                                        ? (crypto as any).randomUUID()
                                        : String(Date.now());
                                    setRerunBusyById((m) => ({ ...m, [it.id]: true }));
                                    setRerunErrorById((m) => ({ ...m, [it.id]: "" }));
                                    try {
                                      const res = await fetchWithTempUser(
                                        `/api/docs/${encodeURIComponent(docId)}/changes/${encodeURIComponent(it.id)}/rerun`,
                                        {
                                          method: "POST",
                                          headers: { "content-type": "application/json", "x-idempotency-key": idKey },
                                          body: JSON.stringify({ qualityTier: tier }),
                                        },
                                      );
                                      if (res.status === 402) {
                                        dispatchOutOfCredits();
                                        return;
                                      }
                                      const json = (await res.json().catch(() => null)) as any;
                                      if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
                                      await refresh();
                                    } catch (e) {
                                      setRerunErrorById((m) => ({ ...m, [it.id]: e instanceof Error ? e.message : "Failed" }));
                                    } finally {
                                      setRerunBusyById((m) => ({ ...m, [it.id]: false }));
                                    }
                                  })();
                                }}
                                title="Regenerate this change summary"
                              >
                                {rerunBusyById[it.id] ? "Regenerating…" : "Regenerate"}
                              </button>
                            </div>
                            {rerunErrorById[it.id] ? (
                              <div className="mt-2 text-xs font-medium text-red-700">{rerunErrorById[it.id]}</div>
                            ) : null}

                            <details
                              className="mt-4"
                              onToggle={(e) => {
                                const el = e.currentTarget;
                                if (!el.open) return;
                                void ensureChangeText(it.id);
                              }}
                            >
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

                            {/* Notification recipients (preview) */}
                            {toV ? (
                              <div className="mt-5 rounded-lg border border-[var(--border)] bg-[var(--panel)] p-3">
                                <div className="flex items-center justify-between gap-3">
                                  <div className="text-xs font-semibold text-[var(--fg)]">Recipients</div>
                                  <button
                                    type="button"
                                    className="text-[11px] font-semibold text-[var(--muted)] hover:text-[var(--fg)]"
                                    onClick={() => void ensureRecipients(toV)}
                                    title="Refresh recipients"
                                  >
                                    {recipientsLoadingByVersion[String(toV)] ? "Loading…" : "Load"}
                                  </button>
                                </div>

                                {(() => {
                                  const rows = recipientsByVersion[String(toV)] ?? [];
                                  const shown = rows.slice(0, 5);
                                  const more = rows.length > 5 ? rows.length - 5 : 0;
                                  if (!rows.length) {
                                    return (
                                      <div className="mt-2 text-xs text-[var(--muted)]">
                                        {recipientsLoadingByVersion[String(toV)]
                                          ? "Loading recipients…"
                                          : "Load to see who will be notified and who opened this version."}
                                      </div>
                                    );
                                  }
                                  return (
                                    <>
                                      <div className="mt-2 divide-y divide-[var(--border)] overflow-hidden rounded-md border border-[var(--border)] bg-[var(--bg)]">
                                        {shown.map((r) => (
                                          <div key={r.userId} className="flex items-center justify-between gap-3 px-3 py-2">
                                            <div className="min-w-0">
                                              <div className="truncate text-xs font-medium text-[var(--fg)]">
                                                {r.name ?? r.email ?? "Unknown"}
                                              </div>
                                              {r.name && r.email ? (
                                                <div className="truncate text-[11px] text-[var(--muted)]">{r.email}</div>
                                              ) : null}
                                            </div>
                                            <div className="flex shrink-0 items-center gap-2">
                                              <span
                                                className={[
                                                  "inline-flex items-center rounded-md px-2 py-0.5 text-[11px] font-semibold",
                                                  r.opened
                                                    ? "bg-emerald-50 text-emerald-800 ring-1 ring-inset ring-emerald-200 dark:bg-emerald-500/10 dark:text-emerald-300 dark:ring-0"
                                                    : "bg-[var(--panel-hover)] text-[var(--muted-2)]",
                                                ].join(" ")}
                                                title={r.opened ? "Opened (viewed any page)" : "Not opened yet"}
                                              >
                                                {r.opened ? "Opened ✓" : "Not opened"}
                                              </span>
                                              <button
                                                type="button"
                                                className="text-[11px] font-semibold text-[var(--muted)] hover:text-[var(--fg)]"
                                                onClick={() =>
                                                  void openViewerStats({ version: toV, userId: r.userId, name: r.name, email: r.email })
                                                }
                                              >
                                                Stats
                                              </button>
                                            </div>
                                          </div>
                                        ))}
                                      </div>
                                      {more ? (
                                        <div className="mt-2 text-xs text-[var(--muted)]">
                                          +{more} more (See more coming next)
                                        </div>
                                      ) : null}
                                    </>
                                  );
                                })()}
                              </div>
                            ) : null}
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

      {viewerStatsOpen ? (
        <Modal
          open={Boolean(viewerStatsOpen)}
          onClose={() => {
            setViewerStatsOpen(null);
            setViewerStats(null);
            setViewerStatsError(null);
          }}
          ariaLabel="Viewer stats"
        >
          <div className="space-y-3">
            <div className="text-base font-semibold text-[var(--fg)]">Viewer stats</div>
            <div className="text-sm font-semibold text-[var(--fg)]">
              {viewerStatsOpen.name ?? viewerStatsOpen.email ?? "Viewer"} — v{viewerStatsOpen.version}
            </div>

            {viewerStatsLoading ? (
              <div className="text-sm text-[var(--muted)]">Loading…</div>
            ) : viewerStatsError ? (
              <div className="text-sm font-medium text-red-700">{viewerStatsError}</div>
            ) : viewerStats ? (
              <div className="rounded-xl border border-[var(--border)] bg-[var(--panel)] p-4">
                <div className="flex flex-wrap items-center gap-3 text-xs text-[var(--muted)]">
                  <span>
                    Viewed page 1:{" "}
                    <span className="font-medium text-[var(--fg)]">
                      {viewerStats.viewedPage1 ? "Yes" : "No"}
                    </span>
                  </span>
                  <span aria-hidden="true">•</span>
                  <span>
                    Total time:{" "}
                    <span className="font-medium text-[var(--fg)]">
                      {formatDuration(typeof viewerStats.totalDurationMs === "number" ? viewerStats.totalDurationMs : 0)}
                    </span>
                  </span>
                </div>

                <div className="mt-3 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--bg)]">
                  <div className="grid grid-cols-[80px_1fr] gap-2 border-b border-[var(--border)] px-3 py-2 text-[11px] font-semibold text-[var(--muted-2)]">
                    <div>Slide</div>
                    <div>Time</div>
                  </div>
                  {(Array.isArray(viewerStats.pages) ? viewerStats.pages : []).map((p: any) => (
                    <div
                      key={String(p.pageNumber)}
                      className="grid grid-cols-[80px_1fr] gap-2 px-3 py-2 text-xs text-[var(--fg)]"
                    >
                      <div className="tabular-nums">#{p.pageNumber}</div>
                      <div className="text-[var(--muted)]">
                        {formatDuration(typeof p.durationMs === "number" ? p.durationMs : 0)}
                      </div>
                    </div>
                  ))}
                  {Array.isArray(viewerStats.pages) && viewerStats.pages.length === 0 ? (
                    <div className="px-3 py-3 text-xs text-[var(--muted)]">No slide timing recorded yet.</div>
                  ) : null}
                </div>
              </div>
            ) : null}
          </div>
        </Modal>
      ) : null}
    </div>
  );
}


