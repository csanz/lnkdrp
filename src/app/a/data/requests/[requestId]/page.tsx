/**
 * Admin route: `/a/data/requests/:requestId`
 *
 * Request repo drilldown: shows full raw request repo data plus related docs/uploads.
 */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { signIn, useSession } from "next-auth/react";
import { useEffect, useMemo, useState } from "react";
import Alert from "@/components/ui/Alert";
import Button from "@/components/ui/Button";
import CopyTextButton from "@/components/ui/CopyTextButton";
import { fmtDate, fmtDuration } from "@/lib/admin/format";
import { fetchJson } from "@/lib/http/fetchJson";

type DetailDoc = {
  id: string;
  userId: string | null;
  title: string | null;
  status: string | null;
  shareId: string | null;
  createdDate: string | null;
  updatedDate: string | null;
  isGuideDoc?: boolean;
  raw: Record<string, unknown> | null;
};

type DetailUpload = {
  id: string;
  userId: string | null;
  docId: string | null;
  version: number | null;
  status: string | null;
  originalFileName: string | null;
  createdDate: string | null;
  updatedDate: string | null;
  raw: Record<string, unknown> | null;
};

type DetailReview = {
  id: string;
  docId: string | null;
  uploadId: string | null;
  version: number | null;
  status: string | null;
  model: string | null;
  outputMarkdown: string | null;
  intel: unknown;
  agentKind: string | null;
  agentOutput: unknown;
  agentRawOutputText: string | null;
  agentSystemPrompt: string | null;
  agentUserPrompt: string | null;
  createdDate: string | null;
  updatedDate: string | null;
  raw: Record<string, unknown> | null;
};

type DetailResponse = {
  ok?: unknown;
  error?: unknown;
  request?: { id?: unknown; raw?: unknown };
  docs?: unknown;
  uploads?: unknown;
  reviews?: unknown;
};

type AiRunRow = {
  id: string;
  kind: string | null;
  status: string | null;
  provider?: string | null;
  model: string | null;
  temperature: number | null;
  maxRetries?: number | null;
  maxTokens?: number | null;
  durationMs: number | null;
  docId: string | null;
  uploadId: string | null;
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
  projectId: string | null;
  projectIds: string[];
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

function prettyJson(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

function extractAiOutput(raw: Record<string, unknown> | null | undefined) {
  if (!raw || typeof raw !== "object") return null;
  const v = (raw as { aiOutput?: unknown }).aiOutput;
  if (!v || typeof v !== "object") return null;
  return v as Record<string, unknown>;
}

export default function AdminDataRequestDetailPage() {
  const routeParams = useParams<{ requestId?: string | string[] }>();
  const requestIdRaw = routeParams?.requestId;
  const requestId = typeof requestIdRaw === "string" ? requestIdRaw : Array.isArray(requestIdRaw) ? requestIdRaw[0] : "";
  const { data: session, status } = useSession();
  const role = session?.user?.role ?? null;
  const isAuthed = status === "authenticated";
  const isAdmin = isAuthed && role === "admin";
  const isLocalhost =
    typeof window !== "undefined" &&
    (window.location.hostname === "localhost" || window.location.hostname === "127.0.0.1");
  const canUseAdmin = isAdmin || isLocalhost;

  const [data, setData] = useState<{
    requestRaw: Record<string, unknown> | null;
    docs: DetailDoc[];
    uploads: DetailUpload[];
    reviews: DetailReview[];
  }>({ requestRaw: null, docs: [], uploads: [], reviews: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<"request" | "docs" | "uploads" | "ai">("request");

  const [aiRuns, setAiRuns] = useState<AiRunRow[]>([]);
  const [aiRunsLoading, setAiRunsLoading] = useState(false);
  const [aiRunsError, setAiRunsError] = useState<string | null>(null);
  const [selectedAiRunId, setSelectedAiRunId] = useState<string | null>(null);
  const [aiRunDetail, setAiRunDetail] = useState<AiRunDetail | null>(null);
  const [aiRunDetailLoading, setAiRunDetailLoading] = useState(false);
  const [aiRunDetailError, setAiRunDetailError] = useState<string | null>(null);

  const header = useMemo(() => {
    const r = data.requestRaw ?? null;
    const name = typeof r?.name === "string" ? r.name : "Request";
    const slug = typeof r?.slug === "string" ? r.slug : null;
    const token =
      typeof (r as { requestUploadToken?: unknown } | null)?.requestUploadToken === "string"
        ? ((r as { requestUploadToken: string }).requestUploadToken as string)
        : null;
    return { name, slug, token };
  }, [data.requestRaw]);

  const copyAllLoadedText = useMemo(() => {
    // One JSON blob with everything currently loaded in the UI.
    return prettyJson({
      requestId,
      request: data.requestRaw,
      docs: data.docs,
      uploads: data.uploads,
      reviews: data.reviews,
      aiRuns,
      selectedAiRunId,
      aiRunDetail,
    });
  }, [aiRunDetail, aiRuns, data.docs, data.requestRaw, data.reviews, data.uploads, requestId, selectedAiRunId]);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (!requestId) return;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const body = await fetchJson<DetailResponse>(`/api/admin/data/requests/${encodeURIComponent(requestId)}`, {
          method: "GET",
        });
        const raw =
          body.request && typeof body.request === "object" && "raw" in body.request
            ? (body.request as { raw?: unknown }).raw
            : null;
        setData({
          requestRaw: raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null,
          docs: Array.isArray(body.docs) ? (body.docs as DetailDoc[]) : [],
          uploads: Array.isArray(body.uploads) ? (body.uploads as DetailUpload[]) : [],
          reviews: Array.isArray(body.reviews) ? (body.reviews as any[]) : [],
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load request");
        setData({ requestRaw: null, docs: [], uploads: [], reviews: [] });
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, requestId]);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (!requestId) return;
    if (tab !== "ai") return;
    setAiRunsLoading(true);
    setAiRunsError(null);
    setSelectedAiRunId(null);
    setAiRunDetail(null);
    setAiRunDetailLoading(false);
    setAiRunDetailError(null);
    void (async () => {
      try {
        const qs = new URLSearchParams();
        qs.set("limit", "100");
        qs.set("page", "1");
        qs.set("projectId", requestId);
        const body = await fetchJson<{ items?: unknown }>(`/api/admin/ai-runs?${qs.toString()}`, { method: "GET" });
        setAiRuns(Array.isArray(body.items) ? (body.items as AiRunRow[]) : []);
      } catch (e) {
        setAiRuns([]);
        setAiRunsError(e instanceof Error ? e.message : "Failed to load AI runs");
      } finally {
        setAiRunsLoading(false);
      }
    })();
  }, [canUseAdmin, requestId, tab]);

  useEffect(() => {
    if (!canUseAdmin) return;
    if (tab !== "ai") return;
    if (!selectedAiRunId) {
      setAiRunDetail(null);
      setAiRunDetailLoading(false);
      setAiRunDetailError(null);
      return;
    }
    setAiRunDetailLoading(true);
    setAiRunDetailError(null);
    void (async () => {
      try {
        const body = await fetchJson<{ run?: unknown }>(`/api/admin/ai-runs/${encodeURIComponent(selectedAiRunId)}`, {
          method: "GET",
        });
        setAiRunDetail((body.run ?? null) as AiRunDetail | null);
      } catch (e) {
        setAiRunDetail(null);
        setAiRunDetailError(e instanceof Error ? e.message : "Failed to load AI run detail");
      } finally {
        setAiRunDetailLoading(false);
      }
    })();
  }, [canUseAdmin, selectedAiRunId, tab]);

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
              onClick={() =>
                void signIn("google", {
                  callbackUrl: requestId ? `/a/data/requests/${encodeURIComponent(requestId)}` : "/a/data/requests",
                })
              }
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
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <Link href="/a/data/requests" className="text-sm text-[var(--muted)] hover:underline">
                Admin / Data / Requests
              </Link>
              <span className="text-sm text-[var(--muted)]">/</span>
              <span className="text-sm font-semibold text-[var(--fg)]">{header.slug ?? header.name}</span>
            </div>
            <h1 className="mt-2 truncate text-xl font-semibold tracking-tight text-[var(--fg)]">{header.name}</h1>
            <div className="mt-1 text-sm text-[var(--muted)]">
              {header.slug ? (
                <span className="inline-flex items-center gap-2">
                  <span>Slug: {header.slug}</span>
                  <CopyTextButton text={header.slug} label="Copy slug" />
                </span>
              ) : null}
              {header.token ? (
                <span className="inline-flex items-center gap-2">
                  <span>{header.slug ? " • " : ""}Token: {header.token.slice(0, 10)}…</span>
                  <CopyTextButton text={header.token} label="Copy token" />
                </span>
              ) : null}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {header.token ? (
              <a
                className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
                href={`/request/${encodeURIComponent(header.token)}`}
                target="_blank"
                rel="noreferrer"
              >
                Open upload page
              </a>
            ) : null}
            <Button
              variant="solid"
              className="bg-[var(--primary-bg)] text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)]"
              disabled={loading}
              onClick={() => {
                // trigger reload by toggling state
                setTab((t) => t);
                // reload happens via effect on requestId; easiest is force by re-setting error/loading state:
                setLoading(true);
                setError(null);
                void (async () => {
                  try {
                    const body = await fetchJson<DetailResponse>(
                      `/api/admin/data/requests/${encodeURIComponent(requestId)}`,
                      { method: "GET" },
                    );
                    const raw =
                      body.request && typeof body.request === "object" && "raw" in body.request
                        ? (body.request as { raw?: unknown }).raw
                        : null;
                    setData({
                      requestRaw: raw && typeof raw === "object" ? (raw as Record<string, unknown>) : null,
                      docs: Array.isArray(body.docs) ? (body.docs as DetailDoc[]) : [],
                      uploads: Array.isArray(body.uploads) ? (body.uploads as DetailUpload[]) : [],
                      reviews: Array.isArray(body.reviews) ? (body.reviews as any[]) : [],
                    });
                  } catch (e) {
                    setError(e instanceof Error ? e.message : "Failed to load request");
                  } finally {
                    setLoading(false);
                  }
                })();
              }}
            >
              Refresh
            </Button>
            <CopyTextButton text={copyAllLoadedText} label="Copy all (loaded)" />
          </div>
        </div>

        {error ? (
          <Alert variant="info" className="mt-5 border border-[var(--border)] bg-[var(--panel)] text-sm text-red-700">
            {error}
          </Alert>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center gap-2 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-2">
          {(
            [
              { key: "request", label: "Request (raw)" },
              { key: "docs", label: `Docs (${data.docs.length})` },
              { key: "uploads", label: `Uploads (${data.uploads.length})` },
              { key: "ai", label: "AI runs" },
            ] as const
          ).map((t) => (
            <button
              key={t.key}
              type="button"
              className={
                tab === t.key
                  ? "rounded-xl bg-[var(--panel-2)] px-3 py-2 text-sm font-semibold text-[var(--fg)]"
                  : "rounded-xl px-3 py-2 text-sm text-[var(--muted)] hover:bg-[var(--panel-hover)]"
              }
              onClick={() => setTab(t.key)}
            >
              {t.label}
            </button>
          ))}
        </div>

        {loading ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
            Loading…
          </div>
        ) : tab === "request" ? (
          <div className="mt-6 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="text-sm font-semibold text-[var(--fg)]">Raw request repo document</div>
              <CopyTextButton text={prettyJson(data.requestRaw)} />
            </div>
            <div className="mt-3 overflow-auto rounded-xl border border-[var(--border)] bg-black/20 p-3">
              <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                {prettyJson(data.requestRaw)}
              </pre>
            </div>
          </div>
        ) : tab === "docs" ? (
          <div className="mt-6 space-y-3">
            {data.docs.map((d) => (
              <div key={d.id} className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[var(--fg)]">{d.title ?? "Untitled"}</div>
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      Status: {d.status ?? "—"} • Created: {fmtDate(d.createdDate) || "—"} • Updated:{" "}
                      {fmtDate(d.updatedDate) || "—"}
                    </div>
                    {d.isGuideDoc ? (
                      <div className="mt-1 text-xs font-semibold text-[var(--muted-2)]">Guide doc</div>
                    ) : null}
                    <div className="mt-1 inline-flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                      <span>Doc ID: {d.id}</span>
                      <CopyTextButton text={d.id} label="Copy ID" />
                    </div>
                    {d.shareId ? (
                      <div className="mt-1 inline-flex flex-wrap items-center gap-2">
                        <a
                          className="inline-block text-xs text-[var(--fg)] hover:underline"
                          href={`/s/${encodeURIComponent(d.shareId)}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          /s/{d.shareId}
                        </a>
                        <CopyTextButton text={d.shareId} label="Copy shareId" />
                      </div>
                    ) : null}
                  </div>
                  <div className="flex items-center gap-2">
                    <Link
                      href={`/a/shareviews/${encodeURIComponent(d.id)}`}
                      className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
                      title="Open Share Views drilldown for this doc"
                    >
                      Share views
                    </Link>
                  </div>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-semibold text-[var(--muted-2)]">
                    Raw doc JSON
                  </summary>
                  <div className="mt-2 overflow-auto rounded-xl border border-[var(--border)] bg-black/20 p-3">
                    <div className="mb-2 flex justify-end">
                      <CopyTextButton text={prettyJson(d.raw)} />
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">{prettyJson(d.raw)}</pre>
                  </div>
                </details>
                {extractAiOutput(d.raw) ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold text-[var(--muted-2)]">
                      AI output (doc.aiOutput)
                    </summary>
                    <div className="mt-2 overflow-auto rounded-xl border border-[var(--border)] bg-black/20 p-3">
                      <div className="mb-2 flex justify-end">
                        <CopyTextButton text={prettyJson(extractAiOutput(d.raw))} />
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                        {prettyJson(extractAiOutput(d.raw))}
                      </pre>
                    </div>
                  </details>
                ) : null}
                {data.reviews.filter((r) => r.docId === d.id).length ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold text-[var(--muted-2)]">
                      Review output ({data.reviews.filter((r) => r.docId === d.id).length})
                    </summary>
                    <div className="mt-2 space-y-3">
                      {data.reviews
                        .filter((r) => r.docId === d.id)
                        .map((r) => (
                          <div key={r.id} className="rounded-xl border border-[var(--border)] bg-black/10 p-3">
                            <div className="flex flex-wrap items-center justify-between gap-2">
                              <div className="text-xs font-semibold text-[var(--fg)]">
                                v{typeof r.version === "number" ? r.version : "—"} • {r.status ?? "—"}
                                {r.model ? ` • ${r.model}` : ""}
                              </div>
                              <div className="text-[10px] text-[var(--muted-2)]">
                                {fmtDate(r.updatedDate) || fmtDate(r.createdDate) || ""}
                              </div>
                            </div>
                            {r.outputMarkdown ? (
                              <div className="mt-2 overflow-auto rounded-lg border border-[var(--border)] bg-black/20 p-2">
                                <div className="mb-2 flex justify-end">
                                  <CopyTextButton text={r.outputMarkdown} label="Copy markdown" />
                                </div>
                                <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                                  {r.outputMarkdown}
                                </pre>
                              </div>
                            ) : null}
                            {r.intel ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-[10px] font-semibold text-[var(--muted-2)]">
                                  Intel (review.intel)
                                </summary>
                                <div className="mt-2 overflow-auto rounded-lg border border-[var(--border)] bg-black/20 p-2">
                                  <div className="mb-2 flex justify-end">
                                    <CopyTextButton text={prettyJson(r.intel)} label="Copy intel" />
                                  </div>
                                  <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                                    {prettyJson(r.intel)}
                                  </pre>
                                </div>
                              </details>
                            ) : null}
                            {r.agentOutput ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-[10px] font-semibold text-[var(--muted-2)]">
                                  Agent output (review.agentOutput)
                                </summary>
                                <div className="mt-2 overflow-auto rounded-lg border border-[var(--border)] bg-black/20 p-2">
                                  <div className="mb-2 flex justify-end">
                                    <CopyTextButton text={prettyJson(r.agentOutput)} label="Copy agent output" />
                                  </div>
                                  <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                                    {prettyJson(r.agentOutput)}
                                  </pre>
                                </div>
                              </details>
                            ) : null}
                            {r.agentRawOutputText ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-[10px] font-semibold text-[var(--muted-2)]">
                                  Raw model output (review.agentRawOutputText)
                                </summary>
                                <div className="mt-2 overflow-auto rounded-lg border border-[var(--border)] bg-black/20 p-2">
                                  <div className="mb-2 flex justify-end">
                                    <CopyTextButton text={r.agentRawOutputText} label="Copy raw output" />
                                  </div>
                                  <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                                    {r.agentRawOutputText}
                                  </pre>
                                </div>
                              </details>
                            ) : null}
                            {r.agentSystemPrompt || r.agentUserPrompt ? (
                              <details className="mt-2">
                                <summary className="cursor-pointer text-[10px] font-semibold text-[var(--muted-2)]">
                                  Prompts (system + user)
                                </summary>
                                <div className="mt-2 space-y-2 overflow-auto rounded-lg border border-[var(--border)] bg-black/20 p-2">
                                  {r.agentSystemPrompt ? (
                                    <div>
                                      <div className="mb-1 flex items-center justify-between">
                                        <div className="text-[10px] font-semibold text-[var(--muted-2)]">System</div>
                                        <CopyTextButton text={r.agentSystemPrompt} label="Copy system" />
                                      </div>
                                      <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                                        {r.agentSystemPrompt}
                                      </pre>
                                    </div>
                                  ) : null}
                                  {r.agentUserPrompt ? (
                                    <div>
                                      <div className="mb-1 flex items-center justify-between">
                                        <div className="text-[10px] font-semibold text-[var(--muted-2)]">User</div>
                                        <CopyTextButton text={r.agentUserPrompt} label="Copy user" />
                                      </div>
                                      <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                                        {r.agentUserPrompt}
                                      </pre>
                                    </div>
                                  ) : null}
                                </div>
                              </details>
                            ) : null}
                            <details className="mt-2">
                              <summary className="cursor-pointer text-[10px] font-semibold text-[var(--muted-2)]">
                                Raw review JSON
                              </summary>
                              <div className="mt-2 overflow-auto rounded-lg border border-[var(--border)] bg-black/20 p-2">
                                <div className="mb-2 flex justify-end">
                                  <CopyTextButton text={prettyJson(r.raw)} />
                                </div>
                                <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                                  {prettyJson(r.raw)}
                                </pre>
                              </div>
                            </details>
                          </div>
                        ))}
                    </div>
                  </details>
                ) : (
                  <div className="mt-3 text-xs text-[var(--muted-2)]">No reviews found for this doc.</div>
                )}
              </div>
            ))}
            {data.docs.length === 0 ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
                No docs found for this request.
              </div>
            ) : null}
          </div>
        ) : tab === "uploads" ? (
          <div className="mt-6 space-y-3">
            {data.uploads.map((u) => (
              <div key={u.id} className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="truncate text-sm font-semibold text-[var(--fg)]">
                      {u.originalFileName ?? "Upload"}
                    </div>
                    <div className="mt-1 text-xs text-[var(--muted)]">
                      Status: {u.status ?? "—"} • Version: {typeof u.version === "number" ? u.version : "—"} • Created:{" "}
                      {fmtDate(u.createdDate) || "—"}
                    </div>
                    <div className="mt-1 inline-flex flex-wrap items-center gap-2 text-xs text-[var(--muted)]">
                      <span>Upload ID: {u.id}</span>
                      <CopyTextButton text={u.id} label="Copy ID" />
                    </div>
                    <div className="mt-1 text-xs text-[var(--muted)]">Doc ID: {u.docId ?? "—"}</div>
                  </div>
                </div>
                <details className="mt-3">
                  <summary className="cursor-pointer text-xs font-semibold text-[var(--muted-2)]">
                    Raw upload JSON
                  </summary>
                  <div className="mt-2 overflow-auto rounded-xl border border-[var(--border)] bg-black/20 p-3">
                    <div className="mb-2 flex justify-end">
                      <CopyTextButton text={prettyJson(u.raw)} />
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">{prettyJson(u.raw)}</pre>
                  </div>
                </details>
                {extractAiOutput(u.raw) ? (
                  <details className="mt-3">
                    <summary className="cursor-pointer text-xs font-semibold text-[var(--muted-2)]">
                      AI output (upload.aiOutput)
                    </summary>
                    <div className="mt-2 overflow-auto rounded-xl border border-[var(--border)] bg-black/20 p-3">
                      <div className="mb-2 flex justify-end">
                        <CopyTextButton text={prettyJson(extractAiOutput(u.raw))} />
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-xs text-[var(--fg)]">
                        {prettyJson(extractAiOutput(u.raw))}
                      </pre>
                    </div>
                  </details>
                ) : null}
              </div>
            ))}
            {data.uploads.length === 0 ? (
              <div className="rounded-2xl border border-[var(--border)] bg-[var(--panel)] px-5 py-4 text-sm text-[var(--muted)]">
                No uploads found for this request.
              </div>
            ) : null}
          </div>
        ) : tab === "ai" ? (
          <div className="mt-6 grid gap-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <div className="text-sm font-semibold text-[var(--fg)]">AI runs (for this request repo)</div>
                  <div className="mt-1 text-sm text-[var(--muted)]">Filtered by this request’s project id ({requestId}).</div>
                </div>
                <Link
                  href="/a/ai-runs"
                  className="inline-flex items-center justify-center rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-2 text-sm font-semibold text-[var(--fg)] transition hover:bg-[var(--panel-hover)]"
                >
                  Open AI runs
                </Link>
              </div>

              {aiRunsLoading ? <div className="mt-4 text-sm text-[var(--muted)]">Loading…</div> : null}
              {aiRunsError ? <div className="mt-4 text-sm text-red-600">{aiRunsError}</div> : null}

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
                    {aiRuns.map((r) => {
                      const selected = selectedAiRunId === r.id;
                      return (
                        <tr
                          key={r.id}
                          className={[
                            "cursor-pointer border-t border-[var(--border)]",
                            selected ? "bg-[var(--panel-hover)]" : "hover:bg-[var(--panel-hover)]",
                          ].join(" ")}
                          onClick={() => setSelectedAiRunId(r.id)}
                          title="Click to inspect prompts/output"
                        >
                          <td className="px-3 py-2 whitespace-nowrap text-[12px] text-[var(--muted)]">
                            {fmtDate(r.createdDate)}
                          </td>
                          <td className="px-3 py-2 font-mono text-[12px]">{r.kind ?? "-"}</td>
                          <td className="px-3 py-2 font-mono text-[12px]">{r.status ?? "-"}</td>
                          <td className="px-3 py-2 font-mono text-[12px]">{r.model ?? "-"}</td>
                          <td className="px-3 py-2 font-mono text-[12px]">
                            {typeof r.temperature === "number" ? r.temperature : "-"}
                          </td>
                          <td className="px-3 py-2 font-mono text-[12px]">{fmtDuration(r.durationMs)}</td>
                        </tr>
                      );
                    })}
                    {!aiRunsLoading && aiRuns.length === 0 ? (
                      <tr>
                        <td className="px-3 py-6 text-center text-sm text-[var(--muted)]" colSpan={6}>
                          No AI runs found for this request repo yet.
                        </td>
                      </tr>
                    ) : null}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="min-w-0 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
              <div className="flex items-center justify-between gap-3">
                <div className="text-sm font-semibold text-[var(--fg)]">Run detail</div>
                {selectedAiRunId ? (
                  <Button
                    variant="outline"
                    size="sm"
                    className="bg-[var(--panel-2)] text-[12px]"
                    onClick={() => setSelectedAiRunId(null)}
                  >
                    Clear
                  </Button>
                ) : null}
              </div>
              <div className="mt-2 text-sm text-[var(--muted)]">
                {selectedAiRunId ? "Shows full prompts and raw output." : "Select a run from the table."}
              </div>

              {aiRunDetailError ? <div className="mt-3 text-sm text-red-600">{aiRunDetailError}</div> : null}
              {aiRunDetailLoading ? <div className="mt-3 text-sm text-[var(--muted)]">Loading detail…</div> : null}

              {aiRunDetail ? (
                <div className="mt-4 space-y-4">
                  <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3">
                    <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Summary</div>
                    <div className="mt-2 flex justify-end">
                      <CopyTextButton text={prettyJson(aiRunDetail)} label="Copy run JSON" />
                    </div>
                    <div className="mt-2 grid gap-2 text-[12px] text-[var(--fg)]">
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <div className="text-[var(--muted)]">ID</div>
                        <div className="font-mono break-all">{aiRunDetail.id}</div>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <div className="text-[var(--muted)]">Kind</div>
                        <div className="font-mono">{aiRunDetail.kind ?? "-"}</div>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <div className="text-[var(--muted)]">Status</div>
                        <div className="font-mono">{aiRunDetail.status ?? "-"}</div>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <div className="text-[var(--muted)]">Model</div>
                        <div className="font-mono">{aiRunDetail.model ?? "-"}</div>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <div className="text-[var(--muted)]">Temp</div>
                        <div className="font-mono">{typeof aiRunDetail.temperature === "number" ? aiRunDetail.temperature : "-"}</div>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <div className="text-[var(--muted)]">Duration</div>
                        <div className="font-mono">{fmtDuration(aiRunDetail.durationMs)}</div>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <div className="text-[var(--muted)]">Doc</div>
                        <div className="font-mono break-all">{aiRunDetail.docId ?? "-"}</div>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <div className="text-[var(--muted)]">Upload</div>
                        <div className="font-mono break-all">{aiRunDetail.uploadId ?? "-"}</div>
                      </div>
                      <div className="grid grid-cols-[110px_1fr] gap-2">
                        <div className="text-[var(--muted)]">Created</div>
                        <div className="font-mono">{fmtDate(aiRunDetail.createdDate)}</div>
                      </div>
                    </div>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">System prompt</div>
                      <CopyTextButton text={aiRunDetail.systemPrompt ?? ""} label="Copy" />
                    </div>
                    <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12px] text-[var(--fg)]">
                      {aiRunDetail.systemPrompt ?? "—"}
                    </pre>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">User prompt</div>
                      <CopyTextButton text={aiRunDetail.userPrompt ?? ""} label="Copy" />
                    </div>
                    <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12px] text-[var(--fg)]">
                      {aiRunDetail.userPrompt ?? "—"}
                    </pre>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Output</div>
                      <CopyTextButton
                        text={
                          aiRunDetail.outputText ??
                          (aiRunDetail.outputObject ? prettyJson(aiRunDetail.outputObject) : "")
                        }
                        label="Copy"
                      />
                    </div>
                    <pre className="mt-2 max-h-[240px] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12px] text-[var(--fg)]">
                      {aiRunDetail.outputText ?? (aiRunDetail.outputObject ? prettyJson(aiRunDetail.outputObject) : "—")}
                    </pre>
                  </div>

                  <div>
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Error</div>
                      <CopyTextButton text={aiRunDetail.error ? prettyJson(aiRunDetail.error) : ""} label="Copy" />
                    </div>
                    <pre className="mt-2 max-h-[180px] overflow-auto whitespace-pre-wrap rounded-xl border border-[var(--border)] bg-[var(--panel-2)] p-3 text-[12px] text-[var(--fg)]">
                      {aiRunDetail.error ? prettyJson(aiRunDetail.error) : "—"}
                    </pre>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}


