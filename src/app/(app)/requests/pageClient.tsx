"use client";

/**
 * Client UI for `/requests`.
 */

import { InboxArrowDownIcon } from "@heroicons/react/24/outline";
import { useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithTempUser } from "@/lib/gating/tempUserClient";

type RequestRepoListItem = {
  id: string;
  name: string;
  description: string;
  docCount?: number;
  updatedDate: string | null;
  createdDate: string | null;
};

type Paged<T> = { items: T[]; total: number; page: number; limit: number };

function formatRelative(iso: string | null) {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return "";
  const diff = Date.now() - t;
  const mins = Math.round(diff / 60000);
  if (mins <= 1) return "Just now";
  if (mins < 60) return `${mins} ${mins === 1 ? "min" : "mins"} ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs} ${hrs === 1 ? "hr" : "hrs"} ago`;
  const days = Math.round(hrs / 24);
  if (days === 1) return "Yesterday";
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

export default function RequestsPageClient() {
  const router = useRouter();
  const [q, setQ] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [data, setData] = useState<Paged<RequestRepoListItem>>({ items: [], total: 0, page: 1, limit: 25 });

  const maxPage = useMemo(() => Math.max(1, Math.ceil(data.total / data.limit)), [data.total, data.limit]);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setError(null);
      try {
        const qStr = q.trim() ? `&q=${encodeURIComponent(q.trim())}` : "";
        const res = await fetchWithTempUser(`/api/requests?limit=${data.limit}&page=${data.page}${qStr}`, {
          cache: "no-store",
        });
        const json = (await res.json().catch(() => ({}))) as Partial<Paged<RequestRepoListItem>> & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(json?.error || "Failed to load request inboxes.");
          return;
        }
        setData({
          items: Array.isArray(json.items) ? json.items : [],
          total: typeof json.total === "number" ? json.total : 0,
          page: typeof json.page === "number" ? json.page : data.page,
          limit: typeof json.limit === "number" ? json.limit : data.limit,
        });
      } catch {
        if (!cancelled) setError("Failed to load request inboxes.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [data.limit, data.page, q]);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-[var(--border)] bg-[var(--panel)] px-6 py-4">
        <div className="flex items-center gap-2">
          <InboxArrowDownIcon className="h-5 w-5 text-[var(--muted-2)]" aria-hidden="true" />
          <div className="text-sm font-semibold text-[var(--fg)]">Received</div>
        </div>
        <div className="mt-1 text-xs text-[var(--muted-2)]">Your request repositories (inboxes) in this workspace.</div>

        <div className="mt-4 flex items-center justify-between gap-3">
          <input
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setData((s) => ({ ...s, page: 1 }));
            }}
            placeholder="Search inboxes"
            className="h-10 w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
          />
          <div className="shrink-0 text-xs text-[var(--muted-2)]">{data.total} total</div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto bg-[var(--bg)] px-6 py-6">
        {error ? (
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        <div className={error ? "mt-4" : ""}>
          <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
            <ul className="divide-y divide-[var(--border)]">
              {data.items.map((p) => {
                const when = formatRelative(p.updatedDate ?? p.createdDate);
                return (
                  <li key={p.id}>
                    <div
                      role="link"
                      tabIndex={0}
                      className="cursor-pointer px-4 py-4 hover:bg-[var(--panel-hover)]"
                      onClick={() => router.push(`/project/${encodeURIComponent(p.id)}`)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        router.push(`/project/${encodeURIComponent(p.id)}`);
                      }}
                    >
                      <div className="flex items-start justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex min-w-0 items-center gap-2">
                            <InboxArrowDownIcon className="h-4 w-4 shrink-0 text-[var(--muted-2)]" aria-hidden="true" />
                            <div className="min-w-0 flex-1 truncate text-[13px] font-semibold text-[var(--fg)]">
                              {p.name || "Request inbox"}
                            </div>
                          </div>
                          {p.description ? (
                            <div className="mt-1 line-clamp-2 text-[12px] text-[var(--muted)]">{p.description}</div>
                          ) : null}
                          <div className="mt-2 flex items-center gap-2 text-[11px] text-[var(--muted-2)]">
                            <span>{when || "-"}</span>
                            {typeof p.docCount === "number" && Number.isFinite(p.docCount) ? (
                              <span className="rounded-md bg-[var(--panel-hover)] px-1.5 py-0 text-[10px] text-[var(--muted)] ring-1 ring-[var(--border)]">
                                {p.docCount} doc{p.docCount === 1 ? "" : "s"}
                              </span>
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  </li>
                );
              })}

              {loading ? (
                <li>
                  <div className="px-4 py-6 text-sm text-[var(--muted)]">Loading…</div>
                </li>
              ) : !data.items.length ? (
                <li>
                  <div className="px-4 py-6 text-sm text-[var(--muted)]">No request inboxes yet.</div>
                </li>
              ) : null}
            </ul>
          </div>
        </div>

        {maxPage > 1 ? (
          <div className="mt-6 flex items-center justify-between gap-3">
            <button
              type="button"
              className={[
                "text-sm font-medium text-[var(--muted)] hover:text-[var(--fg)] hover:underline underline-offset-4",
                data.page <= 1 ? "pointer-events-none text-[var(--muted-2)]" : "",
              ].join(" ")}
              disabled={data.page <= 1}
              onClick={() => setData((s) => ({ ...s, page: Math.max(1, s.page - 1) }))}
            >
              Prev
            </button>
            <div className="text-xs text-[var(--muted-2)]">
              Page {data.page} / {maxPage}
            </div>
            <button
              type="button"
              className={[
                "text-sm font-medium text-[var(--muted)] hover:text-[var(--fg)] hover:underline underline-offset-4",
                data.page >= maxPage ? "pointer-events-none text-[var(--muted-2)]" : "",
              ].join(" ")}
              disabled={data.page >= maxPage}
              onClick={() => setData((s) => ({ ...s, page: s.page + 1 }))}
            >
              Next
            </button>
          </div>
        ) : null}
      </div>
    </div>
  );
}


