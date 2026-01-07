/**
 * Usage table for `/dashboard?tab=usage` (Cursor-style).
 *
 * Requirements:
 * - Always render column headers, even when there are no rows.
 * - Filtering controls (e.g. Included usage) live above the table.
 */
"use client";

import { useEffect, useState } from "react";
import Alert from "@/components/ui/Alert";
import { cn } from "@/lib/cn";
import { formatUsdFromCents } from "@/lib/format/money";
import { CREDITS_SNAPSHOT_REFRESH_EVENT } from "@/lib/client/creditsSnapshotRefresh";

export type UsageRow = {
  id: string;
  createdAt: string; // ISO
  action: "summary" | "review" | "history" | "unknown";
  quality: "basic" | "standard" | "advanced";
  credits: number;
  status: "pending" | "charged" | "refunded" | "failed";
  doc?: { id: string; title: string | null } | null;
  user?: { id: string; name: string | null; email: string | null } | null;
};

type UsageResponse = {
  ok: true;
  canViewSpend?: boolean;
  monthSpendCents?: number | null;
  rows: UsageRow[];
};

// Small in-memory cache: makes tab switching feel instant and avoids re-fetching if the user
// toggles between tabs quickly. This does not change server cache semantics.
const USAGE_TABLE_CACHE_TTL_MS = 30_000;
let usageTableCache: Map<string, { at: number; resp: UsageResponse }> | null = null;

function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return iso;
  try {
    return d.toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  } catch {
    return iso;
  }
}

export default function UsageTable({
  className,
  days,
}: {
  className?: string;
  days: 1 | 7 | 30;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rows, setRows] = useState<UsageRow[]>(() => {
    const key = `${days}|0`;
    const cached = usageTableCache?.get?.(key);
    if (!cached) return [];
    if (Date.now() - cached.at > USAGE_TABLE_CACHE_TTL_MS) return [];
    return Array.isArray(cached.resp.rows) ? cached.resp.rows : [];
  });
  const [canViewSpend, setCanViewSpend] = useState(() => {
    const key = `${days}|0`;
    const cached = usageTableCache?.get?.(key);
    if (!cached) return false;
    if (Date.now() - cached.at > USAGE_TABLE_CACHE_TTL_MS) return false;
    return Boolean(cached.resp.canViewSpend);
  });
  const [showSpend, setShowSpend] = useState(false);
  const [monthSpendCents, setMonthSpendCents] = useState<number | null>(() => {
    const key = `${days}|0`;
    const cached = usageTableCache?.get?.(key);
    if (!cached) return null;
    if (Date.now() - cached.at > USAGE_TABLE_CACHE_TTL_MS) return null;
    return typeof cached.resp.monthSpendCents === "number" ? cached.resp.monthSpendCents : null;
  });
  const [refreshNonce, setRefreshNonce] = useState(0);

  // Re-fetch usage whenever the global credits snapshot is refreshed (uploads, limits changes, etc).
  useEffect(() => {
    const onRefresh = () => setRefreshNonce((v) => v + 1);
    window.addEventListener(CREDITS_SNAPSHOT_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(CREDITS_SNAPSHOT_REFRESH_EVENT, onRefresh);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const cacheKey = `${days}|${showSpend ? 1 : 0}`;
    const cached = usageTableCache?.get?.(cacheKey);
    const cachedFresh = Boolean(cached) && Date.now() - (cached?.at ?? 0) < USAGE_TABLE_CACHE_TTL_MS;
    // If cached data exists, avoid a visible "Loading…" state.
    setBusy(!cachedFresh && rows.length === 0);
    setError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("days", String(days));
        if (showSpend) qs.set("includeSpend", "1");
        const res = await fetch(`/api/dashboard/usage?${qs.toString()}`, { method: "GET" });
        const json = (await res.json().catch(() => null)) as UsageResponse | { error?: string } | null;
        if (!res.ok) throw new Error((json as any)?.error || `Request failed (${res.status})`);
        if (!json || (json as any).ok !== true) throw new Error("Invalid response");
        if (!cancelled) {
          setRows(Array.isArray((json as any).rows) ? ((json as any).rows as UsageRow[]) : []);
          setCanViewSpend(Boolean((json as any).canViewSpend));
          setMonthSpendCents(typeof (json as any).monthSpendCents === "number" ? (json as any).monthSpendCents : null);
        }
        usageTableCache = usageTableCache ?? new Map();
        usageTableCache.set(cacheKey, { at: Date.now(), resp: json as UsageResponse });
      } catch (e) {
        const msg = e instanceof Error ? e.message : "Failed to load usage";
        if (!cancelled) setError(msg);
        // Keep cached data visible if we have it (avoid turning a transient failure into a blank table).
        if (!cancelled && !(usageTableCache?.get?.(cacheKey)?.resp)) {
          setRows([]);
          setMonthSpendCents(null);
        }
      } finally {
        if (!cancelled) setBusy(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [days, showSpend, refreshNonce]);

  return (
    <div className={cn("rounded-2xl bg-[var(--panel)] p-6", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-semibold text-[var(--fg)]">Usage</div>
        <div className="flex items-center gap-2">
          {canViewSpend ? (
            <label className="inline-flex items-center gap-2 text-[12px] font-semibold text-[var(--muted-2)]">
              <input
                type="checkbox"
                checked={showSpend}
                onChange={(e) => setShowSpend(e.target.checked)}
              />
              Show monthly spend
            </label>
          ) : null}
        </div>
      </div>

      {canViewSpend && showSpend ? (
        <div className="mt-3 text-[12px] text-[var(--muted-2)]">
          Month-to-date spend (credits × $0.10):{" "}
          <span className="font-semibold text-[var(--fg)]">
            {monthSpendCents === null ? "—" : formatUsdFromCents(monthSpendCents)}
          </span>
        </div>
      ) : null}

      {error ? (
        <Alert variant="error" className="mt-4 text-[12px]">
          {error}
        </Alert>
      ) : null}

      <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)] bg-[var(--panel-2)]">
        <table className="w-full border-collapse text-left text-[13px]">
          <thead className="bg-[var(--panel)] text-[12px] font-semibold text-[var(--muted-2)]">
            <tr>
              <th className="px-4 py-3">Date</th>
              <th className="px-4 py-3">Action</th>
              <th className="px-4 py-3">Quality</th>
              <th className="px-4 py-3">Doc</th>
              <th className="px-4 py-3">User</th>
              <th className="px-4 py-3 text-right">Credits</th>
              <th className="px-4 py-3">Status</th>
            </tr>
          </thead>
          <tbody>
            {busy ? (
              <tr>
                <td className="px-4 py-5 text-[12px] text-[var(--muted-2)]" colSpan={7}>
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className="px-4 py-5 text-[12px] text-[var(--muted-2)]" colSpan={7}>
                  No usage yet.
                </td>
              </tr>
            ) : (
              rows.map((r) => {
                const docTitle = (r.doc?.title ?? "").trim() || "Untitled";
                const userLabel = (r.user?.name ?? "").trim() || (r.user?.email ?? "").trim() || "—";
                return (
                  <tr key={r.id} className="border-t border-[var(--border)]">
                    <td className="px-4 py-3 text-[var(--muted-2)]">{fmtDateTime(r.createdAt)}</td>
                    <td className="px-4 py-3 text-[var(--muted-2)]">
                      {r.action === "summary" ? "Summary" : r.action === "review" ? "Review" : r.action === "history" ? "History" : "Unknown"}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted-2)]">
                      {r.quality === "basic" ? "Basic" : r.quality === "standard" ? "Standard" : "Advanced"}
                    </td>
                    <td className="px-4 py-3">
                      {r.doc?.id ? (
                        <a className="text-[var(--fg)] underline underline-offset-2" href={`/doc/${encodeURIComponent(r.doc.id)}`}>
                          {docTitle}
                        </a>
                      ) : (
                        <span className="text-[var(--muted-2)]">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-[var(--muted-2)]">{userLabel}</td>
                    <td className="px-4 py-3 text-right text-[var(--muted-2)]">{Number.isFinite(r.credits) ? r.credits.toLocaleString() : "—"}</td>
                    <td className="px-4 py-3 text-[var(--muted-2)]">
                      {r.status === "charged" ? "Charged" : r.status === "pending" ? "Pending" : r.status === "refunded" ? "Refunded" : "Failed"}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}


