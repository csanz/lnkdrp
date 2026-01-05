/**
 * Admin route: `/a/data/requests`
 *
 * Lists request link repos for admin inspection (paged).
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import Input from "@/components/ui/Input";
import DataTable from "@/components/ui/DataTable";
import { fmtDate } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type RequestRow = {
  id: string;
  userId: string | null;
  name: string | null;
  slug: string | null;
  description: string | null;
  shareId: string | null;
  docCount: number | null;
  isRequest: boolean;
  requestUploadToken: string | null;
  requestReviewEnabled: boolean;
  updatedDate: string | null;
  createdDate: string | null;
};

export default function AdminDataRequestsPage() {
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
  const [items, setItems] = useState<RequestRow[]>([]);
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
        const data = await fetchJson<{ requests?: unknown; total?: unknown }>(
          `/api/admin/data/requests?${qs.toString()}`,
          { method: "GET" },
        );
        setItems(Array.isArray(data.requests) ? (data.requests as RequestRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load requests");
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Requests</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] px-5 py-2.5 text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/data/requests" })}
            >
              Sign in
            </Button>
          </div>
        </div>
      </div>
    );
  }

  if (!canUseAdmin) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / Data / Requests</div>
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
            <h1 className="text-xl font-semibold tracking-tight text-[var(--fg)]">Admin / Data / Requests</h1>
            <p className="mt-1 text-sm text-[var(--muted)]">Paged list of request link repos.</p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="w-[260px] max-w-full"
              placeholder="Search name, slug, shareId, token…"
              value={q}
              onChange={(e) => {
                setPage(1);
                setQ(e.target.value);
              }}
            />
            <div className="text-xs text-[var(--muted-2)]">
              Page {page} / {totalPages} • {total} total
            </div>
            <Button
              variant="outline"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
            >
              Prev
            </Button>
            <Button
              variant="outline"
              disabled={page >= totalPages}
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
            >
              Next
            </Button>
          </div>
        </div>

        {error ? (
          <Alert variant="info" className="mt-5 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
            {error}
          </Alert>
        ) : null}

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : (
          <DataTable containerClassName="mt-6">
            <thead className="border-b border-[var(--border)] bg-[var(--panel-2)]">
              <tr className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                <th className="px-4 py-3">Name</th>
                <th className="px-4 py-3">Slug</th>
                <th className="px-4 py-3">Docs</th>
                <th className="px-4 py-3">Review</th>
                <th className="px-4 py-3">Upload link</th>
                <th className="px-4 py-3">Updated</th>
                <th className="px-4 py-3">User ID</th>
                <th className="px-4 py-3">Project ID</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {items.map((r) => (
                <tr key={r.id}>
                  <td className="px-4 py-3">
                    <div className="min-w-0">
                      <Link
                        href={`/a/data/requests/${encodeURIComponent(r.id)}`}
                        className="truncate font-semibold text-[var(--fg)] hover:underline"
                        title="Open request drilldown"
                      >
                        {r.name ?? "—"}
                      </Link>
                      {r.description ? <div className="mt-1 truncate text-xs text-[var(--muted)]">{r.description}</div> : null}
                    </div>
                  </td>
                  <td className="px-4 py-3">{r.slug ?? "—"}</td>
                  <td className="px-4 py-3">{typeof r.docCount === "number" ? r.docCount : "—"}</td>
                  <td className="px-4 py-3">{r.requestReviewEnabled ? "Enabled" : "Off"}</td>
                  <td className="px-4 py-3">
                    {r.requestUploadToken ? (
                      <a
                        className="font-mono text-xs text-[var(--fg)] hover:underline"
                        href={`/request/${encodeURIComponent(r.requestUploadToken)}`}
                        target="_blank"
                        rel="noreferrer"
                        title="Open public request upload page"
                      >
                        /request/{r.requestUploadToken.slice(0, 8)}…
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                  <td className="px-4 py-3">{fmtDate(r.updatedDate) || fmtDate(r.createdDate) || "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{r.userId ?? "—"}</td>
                  <td className="px-4 py-3 font-mono text-xs text-[var(--muted)]">{r.id}</td>
                </tr>
              ))}
              {items.length === 0 ? (
                <tr>
                  <td className="px-4 py-6 text-sm text-[var(--muted)]" colSpan={8}>
                    No requests.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </DataTable>
        )}
      </div>
    </div>
  );
}


