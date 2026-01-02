/**
 * Admin route: `/a/data/docs`
 *
 * Lists docs across all users for admin inspection (paged).
 */
"use client";

import Link from "next/link";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";

type DocRow = {
  id: string;
  userId: string | null;
  title: string | null;
  status: string | null;
  shareId: string | null;
  isArchived: boolean;
  updatedDate: string | null;
  createdDate: string | null;
};

function fmtDate(v: string | null | undefined) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.valueOf())) return v;
  return d.toLocaleString();
}

export default function AdminDataDocsPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [q, setQ] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<DocRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const totalPages = useMemo(() => Math.max(1, Math.ceil((total || 0) / limit)), [total, limit]);

  useEffect(() => {
    if (!canUseAdmin) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("limit", String(limit));
        qs.set("page", String(page));
        if (q.trim()) qs.set("q", q.trim());
        const res = await fetch(`/api/admin/data/docs?${qs.toString()}`, { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as {
          error?: unknown;
          docs?: unknown;
          total?: unknown;
        };
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Failed to load docs");
          setItems([]);
          setTotal(0);
          return;
        }
        setItems(Array.isArray(data.docs) ? (data.docs as DocRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch {
        setError("Failed to load docs");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, limit, page, q]);

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Docs</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/data/docs" })}
            >
              Sign in
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Docs</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-6xl px-6 py-8">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Data / Docs</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Paged list of docs across all users.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <input
              className="w-[260px] max-w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm text-[var(--fg)]"
              placeholder="Search title or shareId…"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
            />
            <div className="text-xs text-[var(--muted-2)]">
              Page {page} / {totalPages} • {total} total
            </div>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] disabled:opacity-60"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </button>
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)] disabled:opacity-60"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </button>
          </div>
        </div>

        {error ? (
          <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-3 text-sm text-red-700">
            {error}
          </div>
        ) : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <div className="mt-6 overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--panel)]">
            <div className="overflow-x-auto">
              <table className="min-w-full text-left text-sm">
                <thead className="border-b border-[var(--border)] bg-[var(--panel-2)]">
                  <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                    <th className="px-4 py-3">Title</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Archived</th>
                    <th className="px-4 py-3">Share</th>
                    <th className="px-4 py-3">Updated</th>
                    <th className="px-4 py-3">User ID</th>
                    <th className="px-4 py-3">Doc ID</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[var(--border)]">
                  {items.map((d) => (
                    <tr key={d.id}>
                      <td className="px-4 py-3">{d.title ?? "—"}</td>
                      <td className="px-4 py-3">{d.status ?? "—"}</td>
                      <td className="px-4 py-3">{d.isArchived ? "Yes" : "No"}</td>
                      <td className="px-4 py-3">
                        {d.shareId ? (
                          <a
                            className="text-[var(--fg)] underline decoration-[var(--border)] underline-offset-2 hover:decoration-[var(--muted)]"
                            href={`/s/${encodeURIComponent(d.shareId)}`}
                            target="_blank"
                            rel="noreferrer"
                          >
                            /s/{d.shareId}
                          </a>
                        ) : (
                          "—"
                        )}
                      </td>
                      <td className="px-4 py-3">{fmtDate(d.updatedDate) || "—"}</td>
                      <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{d.userId ?? "—"}</td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/a/shareviews/${encodeURIComponent(d.id)}`}
                          className="font-mono text-xs text-[var(--muted)] hover:underline"
                          title="Open Share Views drilldown for this doc"
                        >
                          {d.id}
                        </Link>
                      </td>
                    </tr>
                  ))}
                  {items.length === 0 ? (
                    <tr>
                      <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={7}>
                        No docs.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}




