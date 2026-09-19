"use client";

import { SparklesIcon } from "@heroicons/react/24/outline";
import { useState, type RefObject, type ReactNode } from "react";
import Modal from "@/components/modals/Modal";
import Markdown from "@/components/Markdown";
import LinksManager from "@/components/links/LinksManager";

/**
 * Doc side panel: the links summary, the quick stats and the AI snapshot.
 *
 * The document-level share controls (share URL, "Share enabled", "Allow download", "Show version
 * history", the password lock) used to live here. Every one of them is now a per-link setting, so
 * they moved to `/doc/:docId/links`; the panel keeps `LinksManager variant="panel"`.
 *
 * The props they used are still accepted (the doc page passes them unchanged) — they are simply no
 * longer rendered.
 */
type Props = {
  docId: string;
  /** @deprecated Unused since links moved to `/doc/:docId/links`; the manager resolves its own URL. */
  shareUrl: string;
  shareInputRef: RefObject<HTMLInputElement | null>;
  isCopying: boolean;
  copyDone: boolean;
  onCopy: () => void;
  shareEnabled: boolean;
  onShareEnabledChange: (enabled: boolean) => void;
  relevancyEnabled: boolean;
  onToggleRelevancy: (next: boolean) => void;
  pdfDownloadEnabled: boolean;
  onPdfDownloadEnabledChange: (enabled: boolean) => void;
  revisionHistoryEnabled: boolean;
  onRevisionHistoryEnabledChange: (enabled: boolean) => void;
  sharePasswordEnabled: boolean;
  onSharePasswordEnabledChange: (enabled: boolean) => void;
  aiOutput?: unknown | null;
  uploadError?: unknown | null;
  /** Optional quick-stats card rendered between the share controls and the Snapshot. */
  quickStats?: ReactNode;
  /** Optional notice rendered directly under the links summary (e.g. a plan-limit prompt). */
  shareNotice?: ReactNode;
  /** Who wrote the summary when it was not LinkDrop (e.g. "Claude Code" for an agent-written summary). */
  summaryAuthorLabel?: string | null;
  /** Replaces the "summary not available" text, e.g. a skipped-for-credits notice with a "Write summary" action. */
  summaryMissing?: ReactNode;
  /** @deprecated The links manager reads the plan itself; kept so the doc page compiles unchanged. */
  showProPill?: boolean;
  /** @deprecated See `showProPill`. */
  onProPillClick?: () => void;
};

/**
 * Render the DocSharePanel UI (uses local state).
 */


export default function DocSharePanel({
  docId,
  shareUrl,
  shareInputRef,
  isCopying,
  copyDone,
  onCopy,
  shareEnabled,
  onShareEnabledChange,
  relevancyEnabled,
  onToggleRelevancy,
  pdfDownloadEnabled,
  onPdfDownloadEnabledChange,
  revisionHistoryEnabled,
  onRevisionHistoryEnabledChange,
  sharePasswordEnabled,
  onSharePasswordEnabledChange,
  aiOutput,
  uploadError,
  quickStats,
  shareNotice,
  summaryAuthorLabel,
  summaryMissing,
  showProPill = false,
  onProPillClick,
}: Props) {
  const [aiExtractOpen, setAiExtractOpen] = useState(false);

  // --- Links ------------------------------------------------------------------------------
  // Link management moved to `LinksManager` (and to `/doc/:docId/links`); the panel keeps only
  // the compact summary (docs/prds/lnkdrp-multi-links.md). The document-level share controls it
  // replaced were per-document duplicates of per-link settings, so they are gone — but the doc
  // page still passes their props, and they stay in `Props` so nothing there has to change.
  void shareUrl;
  void shareInputRef;
  void isCopying;
  void copyDone;
  void onCopy;
  void shareEnabled;
  void onShareEnabledChange;
  void relevancyEnabled;
  void onToggleRelevancy;
  void pdfDownloadEnabled;
  void onPdfDownloadEnabledChange;
  void revisionHistoryEnabled;
  void onRevisionHistoryEnabledChange;
  void sharePasswordEnabled;
  void onSharePasswordEnabledChange;
  void showProPill;
  void onProPillClick;

  const ai = aiOutput && typeof aiOutput === "object" ? (aiOutput as Record<string, unknown>) : null;
  const oneLiner = typeof ai?.one_liner === "string" ? ai.one_liner.trim() : "";
  const why =
    typeof ai?.core_problem_or_need === "string" ? ai.core_problem_or_need.trim() : "";
  const scope = Array.isArray(ai?.primary_capabilities_or_scope)
    ? (ai?.primary_capabilities_or_scope as unknown[])
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((s) => s.trim())
    : [];
  const context =
    typeof ai?.intended_use_or_context === "string" ? ai.intended_use_or_context.trim() : "";
  const value =
    typeof ai?.outcomes_or_value === "string" ? ai.outcomes_or_value.trim() : "";
  const maturity =
    typeof ai?.maturity_or_status === "string" ? ai.maturity_or_status.trim() : "";
  const ask = typeof ai?.ask === "string" ? ai.ask.trim() : "";
  const metrics = Array.isArray(ai?.key_metrics)
    ? (ai?.key_metrics as unknown[])
        .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
        .map((s) => s.trim())
    : [];
  const summary = typeof ai?.summary === "string" ? ai.summary.trim() : "";
  // Agent-written summaries carry `summary_by`; otherwise LinkDrop wrote it.
  const summaryByStored =
    ai?.summary_by && typeof ai.summary_by === "object"
      ? ((ai.summary_by as { label?: unknown; client?: unknown }).label ?? (ai.summary_by as { client?: unknown }).client)
      : null;
  const summaryBadge = `Written by ${summaryAuthorLabel || (typeof summaryByStored === "string" && summaryByStored.trim()) || "LinkDrop"}`;

  const hasSnapshot = Boolean(oneLiner || why || scope.length || context || value || maturity || ask || metrics.length);
  // Short summaries often come back identical to the one-liner (an agent passing one sentence for
  // both); showing it twice read as a rendering bug.
  const norm = (t: string) => t.replace(/\s+/g, " ").trim().toLowerCase();
  const hasSummary = Boolean(summary) && norm(summary) !== norm(oneLiner);

  const uploadErrObj =
    uploadError && typeof uploadError === "object" ? (uploadError as Record<string, unknown>) : null;
  const uploadErrDetails =
    uploadErrObj && uploadErrObj.details && typeof uploadErrObj.details === "object"
      ? (uploadErrObj.details as Record<string, unknown>)
      : null;
  const aiWarning =
    uploadErrDetails && typeof uploadErrDetails.ai === "string" ? uploadErrDetails.ai.trim() : "";
  const aiMissingMessage =
    !hasSnapshot && aiWarning
      ? aiWarning
      : !hasSnapshot
        ? "The summary is not available for this upload yet."
        : "";

  return (
    <div className="min-h-0 overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      {/* 1) Links — the default link, the count, and the way through to /doc/:docId/links */}
      <LinksManager scope={{ kind: "doc", id: docId }} variant="panel" />

      {shareNotice ? <div className="mt-2">{shareNotice}</div> : null}

      {/* 1b) Quick stats (owner engagement glimpse) */}
      {quickStats ? <div className="mt-4">{quickStats}</div> : null}

      {/* 2) Snapshot — same spacing as the cards above it; it used to sit under a rule and a bigger gap. */}
      {hasSnapshot ? (
        <div className="mt-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
            <div className="mb-3 flex items-center justify-between gap-3 border-b border-[var(--divider)] pb-3">
              <div
                className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]"
                title="Summary and key points"
              >
                <SparklesIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
                <span className="truncate">Summary</span>
              </div>
              <div className="shrink-0">
                <button
                  type="button"
                  aria-label="Open full snapshot"
                  title="Open full snapshot"
                  className="inline-flex items-center gap-1 text-xs font-medium text-[var(--muted)] underline decoration-transparent underline-offset-4 transition-colors hover:text-[var(--fg)] hover:decoration-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  onClick={() => setAiExtractOpen(true)}
                >
                  Full snapshot →
                </button>
              </div>
            </div>
            {oneLiner ? (
              <div className="text-[13px] font-semibold leading-snug text-[var(--fg)]">
                {oneLiner}
              </div>
            ) : null}
            {why ? (
              <div className="mt-3 text-[13px] leading-relaxed text-[var(--muted)]">
                <span className="font-semibold text-[var(--fg)]">Why it exists:</span>{" "}
                <span>{why}</span>
              </div>
            ) : null}
            {scope.length ? (
              <ul className="mt-3 list-disc space-y-1.5 pl-4 text-[13px] leading-relaxed text-[var(--muted)]">
                {scope.slice(0, 5).map((s) => (
                  <li key={`scope:${s}`}>{s}</li>
                ))}
              </ul>
            ) : null}

            {hasSummary ? (
              <div className="mt-4 border-t border-[var(--divider)] pt-4 text-[13px] leading-relaxed text-[var(--fg)]">
                <Markdown>{summary}</Markdown>
              </div>
            ) : null}

            {/* Credit as a footnote: as an uppercase badge in the header it shouted, and an agent's
                long name squeezed "Summary" down to "SU…" in the side panel. */}
            <div className="mt-4 text-[11px] text-[var(--muted-2)]">{summaryBadge}</div>
          </div>
        </div>
      ) : (
        <div className="mt-4">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
            <div
              className="flex min-w-0 items-center gap-2 border-b border-[var(--divider)] pb-3 text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]"
              title="Summary and key points"
            >
              <SparklesIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
              <span className="truncate">Summary</span>
              {/* This whole block is the no-summary state, so there is no author to credit:
                  "Written by LinkDrop" beside "not available yet" or "Skipped: …" would claim
                  authorship of something that was never written. */}
            </div>
            <div className="mt-3 text-[13px] leading-relaxed text-[var(--muted)]">
              {summaryMissing ?? aiMissingMessage}
            </div>
          </div>
        </div>
      )}

      <Modal
        open={aiExtractOpen}
        onClose={() => setAiExtractOpen(false)}
        ariaLabel="Summary and key points"
        width={920}
        contentClassName="px-8 pb-8 pt-7"
      >
        <div className="flex items-center gap-2 pr-10">
          <span className="text-[15px] font-semibold text-[var(--fg)]">Summary</span>
          <span className="rounded-md border border-[var(--border)] bg-[var(--panel-2)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)]">
            {summaryBadge}
          </span>
        </div>

        {oneLiner ? (
          <p className="mt-4 max-w-[46rem] text-[20px] font-semibold leading-snug tracking-tight text-[var(--fg)]">{oneLiner}</p>
        ) : null}

        {/* Two columns: the prose on the left, the facts as a compact list on the right. */}
        <div className="mt-6 grid gap-8 md:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
          <div className="min-w-0">
            {summary ? (
              <section>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">Overview</h3>
                <div className="mt-2 text-[14px] leading-7 text-[var(--fg)]">
                  <Markdown>{summary}</Markdown>
                </div>
              </section>
            ) : null}

            {scope.length ? (
              <section className={summary ? "mt-7" : ""}>
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">What it covers</h3>
                <ul className="mt-3 space-y-2">
                  {scope.slice(0, 12).map((s) => (
                    <li key={`scope_full:${s}`} className="flex gap-3 text-[14px] leading-6 text-[var(--fg)]">
                      <span aria-hidden="true" className="mt-[0.6rem] h-1 w-1 shrink-0 rounded-full bg-[var(--muted-2)]" />
                      <span>{s}</span>
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </div>

          <aside className="min-w-0">
            {why || context || value || maturity || ask ? (
              <dl className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)] bg-[var(--panel-2)]">
                {[
                  { label: "Why it exists", text: why },
                  { label: "Where it applies", text: context },
                  { label: "Value", text: value },
                  { label: "Status", text: maturity },
                  { label: "Ask", text: ask },
                ]
                  .filter((row) => row.text)
                  .map((row) => (
                    <div key={row.label} className="px-4 py-3.5">
                      <dt className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">{row.label}</dt>
                      <dd className="mt-1 text-[13px] leading-6 text-[var(--fg)]">{row.text}</dd>
                    </div>
                  ))}
              </dl>
            ) : null}

            {metrics.length ? (
              <section className="mt-6">
                <h3 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--muted-2)]">Key numbers</h3>
                <ul className="mt-3 space-y-1.5">
                  {metrics.slice(0, 12).map((m) => (
                    <li key={`metric:${m}`} className="text-[13px] leading-6 text-[var(--fg)]">
                      {m}
                    </li>
                  ))}
                </ul>
              </section>
            ) : null}
          </aside>
        </div>
      </Modal>

    </div>
  );
}
