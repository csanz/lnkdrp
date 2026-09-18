/**
 * Admin route: `/a/ai-runs`
 *
 * The log of every model call: the list on the left, one run's prompts and output on the right.
 * The list is the dense admin table — a run is six facts, and six facts fit on one line — and the
 * long text lives on the right, where the prompts start folded so the output is what you land on.
 *
 * Two layout rules the page had to learn:
 * - The detail pane only exists once a run is picked. An empty 260×60 card pinned beside 50 rows
 *   left a third of the page blank for its whole length; with nothing selected the table takes the
 *   width, and the pane appears — sticky, so it stays beside whatever row you scrolled to.
 * - A column that says the same thing on every row is decoration. Kind and model ride in one cell,
 *   temperature lives in the detail pane (where it is one of nine facts, not 50 identical zeros),
 *   and the status pill is drawn only for the runs that did not simply complete.
 */
"use client";

import { useEffect, useState } from "react";
import Button from "@/components/ui/Button";
import Panel from "@/components/ui/Panel";
import {
  AdminAlert,
  AdminAccessState,
  AdminFilterBar,
  AdminPageHeader,
  AdminSearchInput,
  AdminSelect,
  AdminTable,
  AdminTableEmpty,
  AdminTableMessage,
  AdminTd,
  AdminTh,
  AdminTr,
  IdCell,
  RowAction,
  RowActions,
  StatusPill,
  TimeCell,
  useAdminAccess,
} from "@/components/admin";
import { fetchJson } from "@/lib/http/fetchJson";
import { fmtDuration } from "@/lib/admin/format";
import { ADMIN_PAGE_CONTAINER } from "@/lib/admin/layout";
import {
  ADMIN_CODE_BLOCK,
  ADMIN_DASH,
  ADMIN_FIELD_LABEL,
  ADMIN_FIELD_VALUE,
  ADMIN_NOTE,
  type AdminTone,
} from "@/lib/admin/ui";

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

const COLUMN_COUNT = 5;

/** A run's state as a tone: completed is the boring case, failed is the one worth seeing. */
function runTone(status: string | null): AdminTone {
  if (status === "failed") return "danger";
  if (status === "started") return "warning";
  return "quiet";
}

/**
 * The happy path is not worth a chip. `completed` is every row on most days, so it reads as plain
 * muted text and only a run that is still going or that failed gets a pill — colour where the
 * state is the message, nothing drawn 50 times.
 */
function RunStatus({ status }: { status: string | null }) {
  const s = (status ?? "").toLowerCase();
  if (!s) return <span className="text-[var(--muted-2)]">{ADMIN_DASH}</span>;
  if (s === "completed") return <span className="text-[var(--muted)]">Completed</span>;
  return (
    <StatusPill tone={runTone(status)} dot={s === "started"}>
      {status}
    </StatusPill>
  );
}

/** One labelled fact in the detail panel. */
function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className={ADMIN_FIELD_LABEL}>{label}</dt>
      <dd className={`mt-0.5 truncate ${ADMIN_FIELD_VALUE}`}>{children}</dd>
    </div>
  );
}

/** A long text block that opens on demand, so four of them do not become four scrollbars. */
function TextBlock({
  label,
  value,
  chars,
  defaultOpen = false,
}: {
  label: string;
  value: string | null;
  chars?: number | null;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--panel)]">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-3 rounded-lg px-3 py-2 hover:bg-[var(--panel-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--fg)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--panel)]">
        <span className={ADMIN_FIELD_LABEL}>{label}</span>
        <span className="text-[11.5px] leading-4 tabular-nums text-[var(--muted-2)]">
          {value ? `${(chars ?? value.length).toLocaleString()} chars` : ADMIN_DASH}
        </span>
      </summary>
      <div className="px-3 pb-3">
        <pre className={`max-h-[320px] ${ADMIN_CODE_BLOCK}`}>{value ?? ADMIN_DASH}</pre>
      </div>
    </details>
  );
}

/** The AI run log: list on the left, one run's prompts and output on the right. */
export default function AdminAiRunsPage() {
  const access = useAdminAccess();
  const canUseAdmin = access.canUseAdmin;

  const [kind, setKind] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [docId, setDocId] = useState("");
  const [page, setPage] = useState(1);
  const [limit] = useState(50);
  const [total, setTotal] = useState(0);
  const [items, setItems] = useState<AiRunRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<AiRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);

  const filtered = Boolean(kind || runStatus || docId.trim());

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
        const data = await fetchJson<{ items?: unknown; total?: unknown }>(`/api/admin/ai-runs?${qs.toString()}`, {
          method: "GET",
        });
        setItems(Array.isArray(data.items) ? (data.items as AiRunRow[]) : []);
        setTotal(typeof data.total === "number" ? data.total : Number(data.total ?? 0) || 0);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load AI runs");
        setItems([]);
        setTotal(0);
      } finally {
        setLoading(false);
      }
    })();
  }, [canUseAdmin, docId, kind, limit, page, reloadKey, runStatus]);

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
        const data = await fetchJson<{ run?: unknown }>(`/api/admin/ai-runs/${encodeURIComponent(selectedId)}`, {
          method: "GET",
        });
        setDetail((data.run ?? null) as AiRunDetail | null);
      } catch (e) {
        setDetail(null);
        setDetailError(e instanceof Error ? e.message : "Failed to load run detail");
      } finally {
        setDetailLoading(false);
      }
    })();
  }, [canUseAdmin, selectedId]);

  if (!canUseAdmin) {
    return <AdminAccessState access={access} title="AI runs" description="Every model call the product made, with the prompts it sent and the output it got back." callbackUrl="/a/ai-runs" />;
  }

  const outputText = detail
    ? (detail.outputText ?? (detail.outputObject ? JSON.stringify(detail.outputObject, null, 2) : null))
    : null;
  const errorText = detail?.error ? JSON.stringify(detail.error, null, 2) : null;

  return (
    <div className="min-h-[100svh] bg-[var(--bg)] text-[var(--fg)]">
      <div className={ADMIN_PAGE_CONTAINER}>
        <AdminPageHeader
          title="AI runs"
          description="Every model call the product made, with the prompts it sent and the output it got back."
        />

        <AdminFilterBar
          className="mt-4"
          page={page}
          pageSize={limit}
          total={total}
          onPageChange={setPage}
          noun="runs"
          loading={loading}
          actions={
            <Button variant="outline" onClick={() => setReloadKey((k) => k + 1)} disabled={loading}>
              Refresh
            </Button>
          }
        >
          <AdminSearchInput
            value={docId}
            onValueChange={(v) => {
              setPage(1);
              setDocId(v);
            }}
            placeholder="Doc ID (Mongo ObjectId)…"
            ariaLabel="Filter runs by document id"
          />
          <AdminSelect
            ariaLabel="Filter by kind"
            value={kind}
            onChange={(e) => {
              setPage(1);
              setKind(e.target.value);
            }}
          >
            <option value="">All kinds</option>
            <option value="reviewDocText">reviewDocText</option>
            <option value="analyzePdfText">analyzePdfText</option>
            <option value="requestReviewInvestorFocused">requestReviewInvestorFocused</option>
          </AdminSelect>
          <AdminSelect
            ariaLabel="Filter by status"
            value={runStatus}
            onChange={(e) => {
              setPage(1);
              setRunStatus(e.target.value);
            }}
          >
            <option value="">All statuses</option>
            <option value="started">Started</option>
            <option value="completed">Completed</option>
            <option value="failed">Failed</option>
          </AdminSelect>
        </AdminFilterBar>

        {error ? (
          <AdminAlert className="mt-3">
            {error}
          </AdminAlert>
        ) : null}

        <div
          className={`mt-3 grid min-w-0 gap-3 ${selectedId ? "xl:grid-cols-[minmax(0,1fr)_380px]" : "grid-cols-1"}`}
        >
          <AdminTable
            ariaLabel="AI runs"
            head={
              <>
                <AdminTh align="right" width="w-[130px]">
                  When
                </AdminTh>
                <AdminTh>Kind</AdminTh>
                <AdminTh width="w-[120px]">Status</AdminTh>
                <AdminTh align="right" width="w-[90px]">
                  Dur
                </AdminTh>
                <AdminTh align="right" sticky>
                  Actions
                </AdminTh>
              </>
            }
          >
            {loading && items.length === 0 ? (
              <AdminTableMessage colSpan={COLUMN_COUNT}>Loading runs…</AdminTableMessage>
            ) : items.length === 0 ? (
              <AdminTableEmpty
                colSpan={COLUMN_COUNT}
                title={filtered ? "No runs match those filters" : "No AI runs yet"}
                hint={filtered ? "Try another kind, status, or clear the document id." : undefined}
              />
            ) : (
              items.map((r) => {
                const selected = selectedId === r.id;
                return (
                  <AdminTr
                    key={r.id}
                    className={selected ? "bg-[var(--panel-hover)]" : undefined}
                    aria-selected={selected}
                    onClick={() => setSelectedId(r.id)}
                    title="Inspect this run's prompts and output"
                  >
                    <AdminTd align="right" numeric>
                      <TimeCell value={r.createdDate} />
                    </AdminTd>
                    {/* Kind and model in one cell: two columns that never changed row to row,
                        and the pair reads as one fact — what was asked of which model. */}
                    <AdminTd primary mono truncate="max-w-[360px]">
                      <span title={[r.kind, r.model].filter(Boolean).join(" · ") || undefined}>
                        {r.kind ?? ADMIN_DASH}
                        {r.model ? <span className="text-[var(--muted-2)]"> · {r.model}</span> : null}
                      </span>
                    </AdminTd>
                    <AdminTd>
                      <RunStatus status={r.status} />
                    </AdminTd>
                    <AdminTd align="right" numeric>
                      {fmtDuration(r.durationMs) || ADMIN_DASH}
                    </AdminTd>
                    <AdminTd align="right" sticky actions>
                      <RowActions>
                        <RowAction
                          title="Inspect this run's prompts and output"
                          onClick={(e) => {
                            e.stopPropagation();
                            setSelectedId(r.id);
                          }}
                        >
                          {selected ? "Showing" : "Inspect"}
                        </RowAction>
                      </RowActions>
                    </AdminTd>
                  </AdminTr>
                );
              })
            )}
          </AdminTable>

          {selectedId ? (
            /* The pane is sticky inside a stretched grid cell, so it stays beside the row you are
               reading instead of scrolling away at the top of a 50-row table. */
            <div className="min-w-0">
              <Panel
                padding="md"
                rounded="xl"
                className="min-w-0 xl:sticky xl:top-4 xl:max-h-[calc(100svh-2rem)] xl:overflow-y-auto"
              >
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="text-[13px] font-semibold leading-5 text-[var(--fg)]">Run detail</div>
                    <div className="mt-0.5 text-[12px] leading-5 text-[var(--muted-2)]">
                      The prompts as sent, and the raw output.
                    </div>
                  </div>
                  <RowAction onClick={() => setSelectedId(null)} title="Clear the selection">
                    Clear
                  </RowAction>
                </div>

                {detailError ? <AdminAlert className="mt-3">{detailError}</AdminAlert> : null}
                {detailLoading ? (
                  <div className="mt-3 text-[13px] text-[var(--muted-2)]">Loading detail…</div>
                ) : null}

                {detail ? (
                  <div className="mt-4 grid min-w-0 grid-cols-[minmax(0,1fr)] gap-3">
                    <dl className="grid min-w-0 grid-cols-2 gap-x-4 gap-y-3 sm:grid-cols-3">
                      <Fact label="Kind">
                        <span className="font-mono text-[12px]" title={detail.kind ?? undefined}>
                          {detail.kind ?? ADMIN_DASH}
                        </span>
                      </Fact>
                      <Fact label="Status">
                        <StatusPill tone={runTone(detail.status)}>{detail.status ?? "unknown"}</StatusPill>
                      </Fact>
                      <Fact label="Model">
                        <span className="font-mono text-[12px]" title={detail.model ?? undefined}>
                          {detail.model ?? ADMIN_DASH}
                        </span>
                      </Fact>
                      <Fact label="Temperature">
                        <span className="tabular-nums">
                          {typeof detail.temperature === "number" ? detail.temperature : ADMIN_DASH}
                        </span>
                      </Fact>
                      <Fact label="Duration">
                        <span className="tabular-nums">{fmtDuration(detail.durationMs) || ADMIN_DASH}</span>
                      </Fact>
                      <Fact label="Created">
                        <span className="tabular-nums">
                          <TimeCell value={detail.createdDate} />
                        </span>
                      </Fact>
                      <Fact label="Run ID">
                        <IdCell value={detail.id} label="run id" />
                      </Fact>
                      <Fact label="Doc ID">
                        <IdCell value={detail.docId} label="doc id" />
                      </Fact>
                      <Fact label="Upload ID">
                        <IdCell value={detail.uploadId} label="upload id" />
                      </Fact>
                    </dl>

                    <TextBlock label="Output" value={outputText} defaultOpen />
                    <TextBlock label="System prompt" value={detail.systemPrompt} />
                    <TextBlock label="User prompt" value={detail.userPrompt} />
                    {errorText ? (
                      <TextBlock label="Error" value={errorText} defaultOpen />
                    ) : (
                      <div className="min-w-0 rounded-lg border border-[var(--border)] px-3 py-2">
                        <span className={ADMIN_FIELD_LABEL}>Error</span>
                        <span className="ml-2 text-[13px] text-[var(--muted-2)]">{ADMIN_DASH}</span>
                      </div>
                    )}

                    <p className={ADMIN_NOTE}>
                      Prompts are stored as sent. Nothing here is re-run; this is the record, not a replay.
                    </p>
                  </div>
                ) : null}
              </Panel>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
