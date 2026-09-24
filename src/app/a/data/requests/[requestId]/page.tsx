/**
 * Admin route: `/a/data/requests/:requestId`
 *
 * Request repo drilldown: the raw request repo record, the docs and uploads under it, and
 * the AI runs behind them — four views behind one segmented control.
 *
 * Presentation is the shared admin kit: one page header, one band under it, titled panels
 * with the same label/value rhythm as the other detail pages, and the AI runs list in the
 * same table density as the admin lists.
 */
"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import Button from "@/components/ui/Button";
import CopyTextButton from "@/components/ui/CopyTextButton";
import {
  AdminAlert,
  AdminAccessState,
  AdminPageHeader,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  DetailGrid,
  DetailPanel,
  DetailRow,
  DetailSection,
  IdCell,
  JsonBlock,
  SegmentedAction,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { ADMIN_DASH } from "@/lib/admin/ui";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import { fmtDuration } from "@/lib/admin/format";
import { pipelineStatusTone } from "@/lib/admin/statusTones";
import { fetchJson } from "@/lib/http/fetchJson";

type DetailDoc = {
  id: string;
  userId: string | null;
  title: string | null;
  status: string | null;
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
  agentKind: string | null;
  /** Size of the prompt the agent ran on — the diagnostic the prompt itself used to stand in for. */
  inputTextChars: number | null;
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
  inputTextChars: number | null;
  /** Shape of the prompts and the output, never the text. See src/lib/admin/docPrivacy.ts. */
  content: {
    hasSystemPrompt: boolean | null;
    systemPromptChars: number | null;
    hasUserPrompt: boolean | null;
    userPromptChars: number | null;
    hasOutputText: boolean | null;
    outputTextChars: number | null;
    hasOutputObject: boolean | null;
  } | null;
  error: unknown;
  updatedDate: string | null;
  createdDate: string | null;
};

type TabKey = "request" | "docs" | "uploads" | "ai";

const AI_RUN_COLUMNS = 6;

/** Pretty-print any value, falling back to `String()` on a cycle. */
function prettyJson(v: unknown) {
  try {
    return JSON.stringify(v, null, 2);
  } catch {
    return String(v);
  }
}

/** "12,345 characters", or a dash when the route did not report a size. */
function charCount(n: number | null | undefined) {
  return typeof n === "number" && Number.isFinite(n) ? `${n.toLocaleString()} characters` : ADMIN_DASH;
}

/** A collapsible block of raw text, on the same rhythm everywhere on this page. */
function RawDisclosure({
  label,
  text,
  copyLabel,
  maxHeight,
}: {
  label: string;
  text: string;
  copyLabel?: string;
  maxHeight?: string;
}) {
  return (
    <details className="mt-2">
      <summary className="cursor-pointer rounded px-1 text-[12px] font-medium leading-5 text-[var(--muted-2)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]">
        {label}
      </summary>
      <JsonBlock
        className="mt-2"
        text={text}
        maxHeight={maxHeight}
        actions={<CopyTextButton text={text} label={copyLabel ?? "Copy"} />}
      />
    </details>
  );
}

/** The request repo drilldown page. */
export default function AdminDataRequestDetailPage() {
  const routeParams = useParams<{ requestId?: string | string[] }>();
  const requestIdRaw = routeParams?.requestId;
  const requestId = typeof requestIdRaw === "string" ? requestIdRaw : Array.isArray(requestIdRaw) ? requestIdRaw[0] : "";
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [data, setData] = useState<{
    requestRaw: Record<string, unknown> | null;
    docs: DetailDoc[];
    uploads: DetailUpload[];
    reviews: DetailReview[];
  }>({ requestRaw: null, docs: [], uploads: [], reviews: [] });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<TabKey>("request");

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
    // Whether the repo is accepting uploads, not the token that does the accepting: `/request/:token`
    // takes documents into this workspace with no session at all.
    const s = (r as { secrets?: { hasRequestUploadToken?: boolean | null } } | null)?.secrets;
    const accepting = s?.hasRequestUploadToken === true;
    return { name, slug, accepting };
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

  const tabOptions = useMemo(
    () =>
      [
        { value: "request" as const, label: "Raw record", title: "The raw request repo document" },
        { value: "docs" as const, label: `Docs (${data.docs.length})`, title: "Docs under this request repo" },
        {
          value: "uploads" as const,
          label: `Uploads (${data.uploads.length})`,
          title: "Uploads under this request repo",
        },
        { value: "ai" as const, label: "AI runs", title: "AI runs for this request repo" },
      ] satisfies ReadonlyArray<{ value: TabKey; label: string; title: string }>,
    [data.docs.length, data.uploads.length],
  );

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
          reviews: Array.isArray(body.reviews) ? (body.reviews as DetailReview[]) : [],
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

  /** Re-fetch the request payload. Same request the mount effect makes. */
  function reload() {
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
          reviews: Array.isArray(body.reviews) ? (body.reviews as DetailReview[]) : [],
        });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load request");
      } finally {
        setLoading(false);
      }
    })();
  }

  if (!canUseAdmin) {
    return (
      <AdminAccessState
        access={access}
        title="Request"
        callbackUrl={requestId ? `/a/data/requests/${encodeURIComponent(requestId)}` : "/a/data/requests"}
      />
    );
  }

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title={header.name}
          description="The request repo record, the docs and uploads under it, and the AI runs behind them."
          actions={
            <>
              <Button variant="outline" disabled={loading} onClick={reload}>
                {loading ? "Loading…" : "Refresh"}
              </Button>
              <CopyTextButton text={copyAllLoadedText} label="Copy all (loaded)" className="px-3 py-2 text-sm" />
            </>
          }
        />

        {/* The band: which view, and the two identifiers support asks for. */}
        <div className="mt-4 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-2.5 py-2">
          <SegmentedAction
            options={tabOptions}
            value={tab}
            onSelect={(next) => setTab(next)}
            ariaLabel="Request view"
          />
          <div className="ml-auto flex flex-wrap items-center gap-x-4 gap-y-1 text-[12px] leading-5 text-[var(--muted-2)]">
            <span className="inline-flex items-center gap-1.5">
              <span>Slug</span>
              <span className="font-mono text-[var(--fg)]">{header.slug ?? ADMIN_DASH}</span>
              {header.slug ? <CopyTextButton text={header.slug} label="Copy" /> : null}
            </span>
            <span className="inline-flex items-center gap-1.5">
              <span>Accepting uploads</span>
              <span className="font-mono text-[var(--fg)]">{header.accepting ? "yes" : "no"}</span>
            </span>
          </div>
        </div>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        {tab === "request" ? (
          <DetailPanel
            className="mt-3"
            title="Raw request repo document"
            description="Everything stored on this request repo bar its capability tokens and public slug."
            actions={<CopyTextButton text={prettyJson(data.requestRaw)} />}
            bodyClassName="p-2"
          >
            <JsonBlock text={loading ? "Loading…" : prettyJson(data.requestRaw)} maxHeight="max-h-[560px]" />
          </DetailPanel>
        ) : null}

        {tab === "docs" ? (
          <div className="mt-3 grid gap-3">
            {loading && data.docs.length === 0 ? (
              <DetailPanel title="Docs" description="Loading…">
                <p className="px-2.5 py-1 text-[13px] leading-5 text-[var(--muted-2)]">Loading docs…</p>
              </DetailPanel>
            ) : data.docs.length === 0 ? (
              <DetailPanel title="Docs" description="Nothing has been uploaded through this request repo yet.">
                <p className="px-2.5 py-1 text-[13px] leading-5 text-[var(--muted-2)]">No docs for this request.</p>
              </DetailPanel>
            ) : (
              data.docs.map((d) => {
                const reviews = data.reviews.filter((r) => r.docId === d.id);
                return (
                  <DetailPanel
                    key={d.id}
                    title={d.title ?? "Untitled"}
                    description={d.isGuideDoc ? "Guide doc" : undefined}
                    actions={
                      <Link
                        href={`/a/shareviews/${encodeURIComponent(d.id)}`}
                        className="inline-flex h-[26px] items-center rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 text-[12px] font-medium leading-4 text-[var(--muted)] transition hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                        title="Open Share Views drilldown for this doc"
                      >
                        Share views
                      </Link>
                    }
                  >
                    <DetailGrid columns={2}>
                      <DetailRow label="Status">
                        {d.status ? <StatusPill tone={pipelineStatusTone(d.status)}>{d.status}</StatusPill> : null}
                      </DetailRow>
                      <DetailRow label="Created">{d.createdDate ? <TimeCell value={d.createdDate} /> : null}</DetailRow>
                      <DetailRow label="Updated">{d.updatedDate ? <TimeCell value={d.updatedDate} /> : null}</DetailRow>
                      <DetailRow label="Doc ID">
                        <IdCell value={d.id} label="doc id" />
                      </DetailRow>
                      <DetailRow label="Reviews">
                        {reviews.length ? (
                          <span className="tabular-nums">{reviews.length}</span>
                        ) : (
                          <span className="text-[var(--muted-2)]">None</span>
                        )}
                      </DetailRow>
                    </DetailGrid>

                    <div className="px-2.5 pb-1">
                      <RawDisclosure label="Raw doc JSON" text={prettyJson(d.raw)} />
                      {reviews.length ? (
                        <details className="mt-2">
                          <summary className="cursor-pointer rounded px-1 text-[12px] font-medium leading-5 text-[var(--muted-2)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]">
                            Review output ({reviews.length})
                          </summary>
                          <div className="mt-2 grid gap-2">
                            {reviews.map((r) => (
                              <div
                                key={r.id}
                                className="rounded-lg border border-[var(--border)] bg-[var(--panel-2)] p-2.5"
                              >
                                <div className="flex flex-wrap items-center justify-between gap-2">
                                  <div className="flex items-center gap-2 text-[12px] leading-5 text-[var(--muted)]">
                                    <span className="font-medium text-[var(--fg)]">
                                      v{typeof r.version === "number" ? r.version : ADMIN_DASH}
                                    </span>
                                    {r.status ? (
                                      <StatusPill tone={pipelineStatusTone(r.status)}>{r.status}</StatusPill>
                                    ) : null}
                                    {r.model ? <span className="font-mono">{r.model}</span> : null}
                                  </div>
                                  <div className="text-[12px] leading-5 tabular-nums text-[var(--muted-2)]">
                                    <TimeCell value={r.updatedDate ?? r.createdDate} />
                                  </div>
                                </div>
                                {/* The review's prompt is the deck's extracted text and its output is
                                    the AI's reading of that deck — the same document the tab above
                                    withholds. What is left is the run: did it happen, on how much
                                    text, and did it fail. */}
                                <p className="mt-2 px-1 text-[12px] leading-5 text-[var(--muted-2)]">
                                  Ran on {charCount(r.inputTextChars)}
                                  {r.agentKind ? ` · ${r.agentKind}` : ""}. Prompt and output are not
                                  available in admin.
                                </p>
                                <RawDisclosure label="Raw review JSON" text={prettyJson(r.raw)} />
                              </div>
                            ))}
                          </div>
                        </details>
                      ) : null}
                    </div>
                  </DetailPanel>
                );
              })
            )}
          </div>
        ) : null}

        {tab === "uploads" ? (
          <div className="mt-3 grid gap-3">
            {loading && data.uploads.length === 0 ? (
              <DetailPanel title="Uploads" description="Loading…">
                <p className="px-2.5 py-1 text-[13px] leading-5 text-[var(--muted-2)]">Loading uploads…</p>
              </DetailPanel>
            ) : data.uploads.length === 0 ? (
              <DetailPanel title="Uploads" description="Nobody has uploaded a file through this request repo yet.">
                <p className="px-2.5 py-1 text-[13px] leading-5 text-[var(--muted-2)]">No uploads for this request.</p>
              </DetailPanel>
            ) : (
              data.uploads.map((u) => {
                return (
                  <DetailPanel key={u.id} title={u.originalFileName ?? "Upload"}>
                    <DetailGrid columns={2}>
                      <DetailRow label="Status">
                        {u.status ? <StatusPill tone={pipelineStatusTone(u.status)}>{u.status}</StatusPill> : null}
                      </DetailRow>
                      <DetailRow label="Version">
                        {typeof u.version === "number" ? <span className="tabular-nums">v{u.version}</span> : null}
                      </DetailRow>
                      <DetailRow label="Created">{u.createdDate ? <TimeCell value={u.createdDate} /> : null}</DetailRow>
                      <DetailRow label="Upload ID">
                        <IdCell value={u.id} label="upload id" />
                      </DetailRow>
                      <DetailRow label="Doc ID">
                        <IdCell value={u.docId} label="doc id" />
                      </DetailRow>
                    </DetailGrid>
                    <div className="px-2.5 pb-1">
                      <RawDisclosure label="Raw upload JSON" text={prettyJson(u.raw)} />
                    </div>
                  </DetailPanel>
                );
              })
            )}
          </div>
        ) : null}

        {tab === "ai" ? (
          <div className="mt-3 grid gap-3 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] 2xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
            <div className="min-w-0">
              <DetailSection
                title="AI runs"
                description="Filtered to this request repo's project id. Newest 100."
                actions={
                  <Link
                    href="/a/ai-runs"
                    className="inline-flex h-[26px] items-center rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 text-[12px] font-medium leading-4 text-[var(--muted)] transition hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]"
                  >
                    All AI runs
                  </Link>
                }
              />
              {aiRunsError ? (
                <AdminAlert className="mt-2">{aiRunsError}</AdminAlert>
              ) : null}
              <AdminTable
                  className="mt-2"
                  ariaLabel="AI runs for this request repo"
                  head={
                    <>
                      <AdminTh align="right">When</AdminTh>
                      <AdminTh>Kind</AdminTh>
                      <AdminTh>Status</AdminTh>
                      <AdminTh>Model</AdminTh>
                      <AdminTh align="right">Temp</AdminTh>
                      <AdminTh align="right">Duration</AdminTh>
                    </>
                  }
                >
                  {aiRunsLoading && aiRuns.length === 0 ? (
                    <AdminTableMessage colSpan={AI_RUN_COLUMNS}>Loading AI runs…</AdminTableMessage>
                  ) : aiRuns.length === 0 ? (
                    <AdminTableEmpty
                      colSpan={AI_RUN_COLUMNS}
                      title="No AI runs yet"
                      hint="Nothing has been summarised or reviewed for this request repo."
                    />
                  ) : (
                    aiRuns.map((r) => {
                      const selected = selectedAiRunId === r.id;
                      return (
                        <AdminTr
                          key={r.id}
                          className={selected ? "cursor-pointer bg-[var(--panel-hover)]" : "cursor-pointer"}
                          aria-selected={selected}
                          tabIndex={0}
                          onClick={() => setSelectedAiRunId(r.id)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelectedAiRunId(r.id);
                            }
                          }}
                          title="Inspect this run"
                        >
                          <AdminTd align="right" numeric>
                            <TimeCell value={r.createdDate} />
                          </AdminTd>
                          <AdminTd primary truncate="max-w-[140px]">
                            <span title={r.kind ?? undefined}>{r.kind ?? ADMIN_DASH}</span>
                          </AdminTd>
                          <AdminTd>
                            {/* Most runs completed: a chip is for the ones that did not. */}
                            {!r.status ? (
                              ADMIN_DASH
                            ) : pipelineStatusTone(r.status) === "quiet" ? (
                              r.status
                            ) : (
                              <StatusPill tone={pipelineStatusTone(r.status)}>{r.status}</StatusPill>
                            )}
                          </AdminTd>
                          <AdminTd mono truncate="max-w-[180px]">
                            <span title={r.model ?? undefined}>{r.model ?? ADMIN_DASH}</span>
                          </AdminTd>
                          <AdminTd align="right" numeric>
                            {typeof r.temperature === "number" ? r.temperature : ADMIN_DASH}
                          </AdminTd>
                          <AdminTd align="right" numeric>
                            {fmtDuration(r.durationMs) || ADMIN_DASH}
                          </AdminTd>
                        </AdminTr>
                      );
                    })
                  )}
                </AdminTable>
            </div>

            <div className="min-w-0">
              <DetailPanel
                title="Run detail"
                description={
                  selectedAiRunId ? "Parameters, timing and failure, not the prompts." : "Select a run from the table."
                }
                actions={
                  aiRunDetail ? (
                    <>
                      <CopyTextButton text={prettyJson(aiRunDetail)} label="Copy JSON" />
                      <Button variant="outline" size="sm" onClick={() => setSelectedAiRunId(null)}>
                        Clear
                      </Button>
                    </>
                  ) : null
                }
              >
                {aiRunDetailError ? (
                  <AdminAlert className="mx-2">{aiRunDetailError}</AdminAlert>
                ) : null}
                {aiRunDetailLoading ? (
                  <p className="px-2.5 py-1 text-[13px] leading-5 text-[var(--muted-2)]">Loading detail…</p>
                ) : null}

                {aiRunDetail ? (
                  <>
                    <DetailGrid>
                      <DetailRow label="Run ID">
                        <IdCell value={aiRunDetail.id} label="run id" />
                      </DetailRow>
                      <DetailRow label="Kind">{aiRunDetail.kind}</DetailRow>
                      <DetailRow label="Status">
                        {aiRunDetail.status ? (
                          <StatusPill tone={pipelineStatusTone(aiRunDetail.status)}>{aiRunDetail.status}</StatusPill>
                        ) : null}
                      </DetailRow>
                      <DetailRow label="Model">
                        {aiRunDetail.model ? <span className="font-mono text-[12px]">{aiRunDetail.model}</span> : null}
                      </DetailRow>
                      <DetailRow label="Temperature">
                        {typeof aiRunDetail.temperature === "number" ? (
                          <span className="tabular-nums">{aiRunDetail.temperature}</span>
                        ) : null}
                      </DetailRow>
                      <DetailRow label="Duration">
                        <span className="tabular-nums">{fmtDuration(aiRunDetail.durationMs)}</span>
                      </DetailRow>
                      <DetailRow label="Doc ID">
                        <IdCell value={aiRunDetail.docId} label="doc id" />
                      </DetailRow>
                      <DetailRow label="Upload ID">
                        <IdCell value={aiRunDetail.uploadId} label="upload id" />
                      </DetailRow>
                      <DetailRow label="Created">
                        {aiRunDetail.createdDate ? <TimeCell value={aiRunDetail.createdDate} /> : null}
                      </DetailRow>
                    </DetailGrid>

                    <div className="px-2.5 pb-1">
                      {/* The user prompt is the customer's document with a template around it, and
                          the output is the model's reading of it. Sizes answer the questions this
                          pane is for — did anything go in, did anything come back — and the error
                          is the run's own, not the customer's. */}
                      <p className="mt-2 px-1 text-[12px] leading-5 text-[var(--muted-2)]">
                        System prompt {charCount(aiRunDetail.content?.systemPromptChars)} · user prompt{" "}
                        {charCount(aiRunDetail.content?.userPromptChars)} · output{" "}
                        {aiRunDetail.content?.hasOutputObject
                          ? "structured"
                          : charCount(aiRunDetail.content?.outputTextChars)}
                        . Prompts and output are not available in admin.
                      </p>
                      <RawDisclosure
                        label="Error"
                        text={aiRunDetail.error ? prettyJson(aiRunDetail.error) : ADMIN_DASH}
                        maxHeight="max-h-[180px]"
                      />
                    </div>
                  </>
                ) : null}
              </DetailPanel>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
