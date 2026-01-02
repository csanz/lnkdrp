/**
 * Admin route: `/a/ai-runs`
 *
 * Inspect AI run logs (prompt + output) for debugging the review agent and PDF analysis.
 */
"use client";

import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";

type AiRunRow = {
  id: string;
  kind: string | null;
  status: string | null;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  maxRetries: number | null;
  maxTokens: number | null;
  durationMs: number | null;
  userId: string | null;
  docId: string | null;
  uploadId: string | null;
  reviewId: string | null;
  systemPromptChars: number;
  userPromptChars: number;
  inputTextChars: number | null;
  updatedDate: string | null;
  createdDate: string | null;
};

type AiRunDetail = {
  id: string;
  kind: string | null;
  status: string | null;
  provider: string | null;
  model: string | null;
  temperature: number | null;
  maxRetries: number | null;
  maxTokens: number | null;
  durationMs: number | null;
  userId: string | null;
  docId: string | null;
  uploadId: string | null;
  reviewId: string | null;
  systemPrompt: string | null;
  userPrompt: string | null;
  inputTextChars: number | null;
  outputText: string | null;
  outputObject: unknown;
  error: unknown;
  updatedDate: string | null;
  createdDate: string | null;
};

function fmtDate(v: string | null | undefined) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.valueOf())) return v;
  return d.toLocaleString();
}

function fmtDuration(ms: number | null | undefined) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  return `${m}m ${Math.round(r)}s`;
}

export default function AdminAiRunsPage() {
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [kind, setKind] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [docId, setDocId] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<AiRunRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

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
        if (kind.trim()) qs.set("kind", kind.trim());
        if (runStatus.trim()) qs.set("status", runStatus.trim());
        if (docId.trim()) qs.set("docId", docId.trim());
        const res = await fetch(`/api/admin/ai-runs?${qs.toString()}`, { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as {
          error?: unknown;
          items?: unknown;
          total?: unknown;
        };
        if (!res.ok) {
          setError(typeof data.error === "string" ? data.error : "Failed to load AI runs");
          setItems([]);
          setTotal(0);
          return;
        }
        setItems(Array.isArray(data.items) ? (data.items as AiRunRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch {
        setError("Failed to load AI runs");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, docId, kind, limit, page, runStatus]);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (!selectedId) {
      setDetail(null);
      setDetailError(null);
      setDetailLoading(false);
      return;
    }
    setDetailLoading(true);
    setDetailError(null);
    void (async () => {
      try {
        const res = await fetch(`/api/admin/ai-runs/${encodeURIComponent(selectedId)}`, { method: "GET" });
        const data = (await res.json().catch(() => ({}))) as { error?: unknown; run?: unknown };
        if (!res.ok) {
          setDetail(null);
          setDetailError(typeof data.error === "string" ? data.error : "Failed to load run detail");
          return;
        }
        setDetail((data.run ?? null) as AiRunDetail | null);
      } catch {
        setDetail(null);
        setDetailError("Failed to load run detail");
      } finally {
        setDetailLoading(false);
      }
    })();
  }, [canUseAdmin, selectedId]);

  if (status === "loading") {
    return <div className="px-6 py-8 text-sm text-[var(--muted)]">Loading…</div>;
  }

  if (!isAuthed && !isLocalhost) {
    return (
      <div className="px-6 py-10">
        <div className="max-w-xl rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-6">
          <div className="text-base font-semibold text-[var(--fg)]">Admin / AI runs</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You must be signed in to view this page.</p>
          <div className="mt-5">
            <button
              type="button"
              className="inline-flex items-center justify-center rounded-xl bg-[var(--primary-bg)] px-5 py-2.5 text-sm font-semibold text-[var(--primary-fg)] shadow-sm transition hover:bg-[var(--primary-hover-bg)]"
              onClick={() => void signIn("google", { callbackUrl: "/a/ai-runs" })}
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
          <div className="text-base font-semibold text-[var(--fg)]">Admin / AI runs</div>
          <p className="mt-2 text-sm leading-6 text-[var(--muted)]">You don’t have access to this page.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className="mx-auto w-full max-w-7xl px-6 py-8">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="text-xl font-semibold tracking-tight text-[var(--fg)]">AI runs</div>
            <div className="mt-1 text-sm text-[var(--muted)]">Inspect prompts, model params, and outputs for AI features.</div>
          </div>
          <Link
            href="/a"
            className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
          >
            Back
          </Link>
        </div>

        <div className="mt-6 grid gap-4 lg:grid-cols-[1.2fr_0.8fr]">
          <div className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[180px]">
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Kind</div>
                <select
                  value={kind}
                  onChange={(e) => {
                    setPage(1);
                    setKind(e.target.value);
                  }}
                  className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm"
                >
                  <option value="">All</option>
                  <option value="reviewDocText">reviewDocText</option>
                  <option value="analyzePdfText">analyzePdfText</option>
                  <option value="requestReviewInvestorFocused">requestReviewInvestorFocused</option>
                </select>
              </div>
              <div className="min-w-[180px]">
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Status</div>
                <select
                  value={runStatus}
                  onChange={(e) => {
                    setPage(1);
                    setRunStatus(e.target.value);
                  }}
                  className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm"
                >
                  <option value="">All</option>
                  <option value="started">started</option>
                  <option value="completed">completed</option>
                  <option value="failed">failed</option>
                </select>
              </div>
              <div className="min-w-[280px] flex-1">
                <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Doc ID (optional)</div>
                <input
                  value={docId}
                  onChange={(e) => {
                    setPage(1);
                    setDocId(e.target.value);
                  }}
                  placeholder="Mongo ObjectId"
                  className="mt-1 w-full rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm"
                />
              </div>
            </div>

            {error ? <div className="mt-3 text-sm text-red-600">{error}</div> : null}

            <div className="mt-4 overflow-hidden rounded-xl border border-[var(--border)]">
              <table className="w-full border-collapse text-sm">
                <thead className="bg-[var(--panel-2)] text-[var(--muted)]">
                  <tr>
                    <th className="px-3 py-2 text-left font-semibold">When</th>
                    <th className="px-3 py-2 text-left font-semibold">Kind</th>
                    <th className="px-3 py-2 text-left font-semibold">Status</th>
                    <th className="px-3 py-2 text-left font-semibold">Model</th>
                    <th className="px-3 py-2 text-left font-semibold">Temp</th>
                    <th className="px-3 py-2 text-left font-semibold">Dur</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((r) => {
                    const selected = selectedId === r.id;
                    return (
                      <tr
                        key={r.id}
                        className={[
                          "cursor-pointer border-t border-[var(--border)]",
                          selected ? "bg-[var(--panel-hover)]" : "hover:bg-[var(--panel-hover)]",
                        ].join(" ")}
                        onClick={() => setSelectedId(r.id)}
                        title="Click to inspect prompts/output"
                      >
                        <td className="px-3 py-2 whitespace-nowrap text-[12px] text-[var(--muted)]">{fmtDate(r.createdDate)}</td>
                        <td className="px-3 py-2 font-mono text-[12px]">{r.kind ?? "-"}</td>
                        <td className="px-3 py-2 font-mono text-[12px]">{r.status ?? "-"}</td>
                        <td className="px-3 py-2 font-mono text-[12px]">{r.model ?? "-"}</td>
                        <td className="px-3 py-2 font-mono text-[12px]">{typeof r.temperature === "number" ? r.temperature : "-"}</td>
                        <td className="px-3 py-2 font-mono text-[12px]">{fmtDuration(r.durationMs)}</td>
                      </tr>
                    );
                  })}
                  {!loading && items.length === 0 ? (
                    <tr>
                      <td className="px-3 py-6 text-center text-sm text-[var(--muted)]" colSpan={6}>
                        No runs found.
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <div className="mt-4 flex items-center justify-between gap-3">
              <div className="text-sm text-[var(--muted)]">
                {loading ? "Loading…" : `${total} total`} • Page {page} / {totalPages}
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm font-semibold hover:bg-[var(--panel-hover)] disabled:opacity-50"
                  disabled={page <= 1 || loading}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >
                  Prev
                </button>
                <button
                  type="button"
                  className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm font-semibold hover:bg-[var(--panel-hover)] disabled:opacity-50"
                  disabled={page >= totalPages || loading}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                >
                  Next
                </button>
              </div>
            </div>
          </div>

          <div className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold">Run detail</div>
              {selectedId ? (
                <button
                  type="button"
                  className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-1.5 text-[12px] font-semibold hover:bg-[var(--panel-hover)]"
                  onClick={() => setSelectedId(null)}
                >
                  Clear
                </button>
              ) : null}
            </div>
            <div className="mt-2 text-sm text-[var(--muted)]">
              {selectedId ? "Shows full system/user prompts and raw output." : "Select a run from the table."}
            </div>

            {detailError ? <div className="mt-3 text-sm text-red-600">{detailError}</div> : null}
            {detailLoading ? <div className="mt-3 text-sm text-[var(--muted)]">Loading detail…</div> : null}

            {detail ? (
              <div className="mt-4 space-y-4">
                <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Summary</div>
                  <div className="mt-2 grid gap-2 text-[12px] text-[var(--fg)]">
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <div className="text-[var(--muted)]">ID</div>
                      <div className="font-mono break-all">{detail.id}</div>
                    </div>
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <div className="text-[var(--muted)]">Kind</div>
                      <div className="font-mono">{detail.kind ?? "-"}</div>
                    </div>
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <div className="text-[var(--muted)]">Status</div>
                      <div className="font-mono">{detail.status ?? "-"}</div>
                    </div>
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <div className="text-[var(--muted)]">Model</div>
                      <div className="font-mono">{detail.model ?? "-"}</div>
                    </div>
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <div className="text-[var(--muted)]">Temp</div>
                      <div className="font-mono">{typeof detail.temperature === "number" ? detail.temperature : "-"}</div>
                    </div>
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <div className="text-[var(--muted)]">Duration</div>
                      <div className="font-mono">{fmtDuration(detail.durationMs)}</div>
                    </div>
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <div className="text-[var(--muted)]">Doc</div>
                      <div className="font-mono break-all">{detail.docId ?? "-"}</div>
                    </div>
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <div className="text-[var(--muted)]">Upload</div>
                      <div className="font-mono break-all">{detail.uploadId ?? "-"}</div>
                    </div>
                    <div className="grid grid-cols-[110px_1fr] gap-2">
                      <div className="text-[var(--muted)]">Created</div>
                      <div className="font-mono">{fmtDate(detail.createdDate)}</div>
                    </div>
                  </div>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">System prompt</div>
                  <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12px] text-[var(--fg)]">
                    {detail.systemPrompt ?? "—"}
                  </pre>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">User prompt</div>
                  <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12px] text-[var(--fg)]">
                    {detail.userPrompt ?? "—"}
                  </pre>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Output</div>
                  <pre className="mt-2 max-h-[260px] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12px] text-[var(--fg)]">
                    {detail.outputText ?? (detail.outputObject ? JSON.stringify(detail.outputObject, null, 2) : "—")}
                  </pre>
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Error</div>
                  <pre className="mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12px] text-[var(--fg)]">
                    {detail.error ? JSON.stringify(detail.error, null, 2) : "—"}
                  </pre>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}


