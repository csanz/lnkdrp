"use client";

import { LockClosedIcon, LockOpenIcon, SparklesIcon, Square2StackIcon } from "@heroicons/react/24/outline";
import { useState, type RefObject } from "react";
import Modal from "@/components/modals/Modal";
import Markdown from "@/components/Markdown";
import { fetchJson } from "@/lib/http/fetchJson";
import { CopyButton } from "@/components/CopyButton";

type Props = {
  docId: string;
  shareUrl: string;
  shareInputRef: RefObject<HTMLInputElement | null>;
  isCopying: boolean;
  copyDone: boolean;
  onCopy: () => void;
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
  relevancyEnabled: _relevancyEnabled,
  onToggleRelevancy: _onToggleRelevancy,
  pdfDownloadEnabled,
  onPdfDownloadEnabledChange,
  revisionHistoryEnabled,
  onRevisionHistoryEnabledChange,
  sharePasswordEnabled,
  onSharePasswordEnabledChange,
  aiOutput,
  uploadError,
}: Props) {
  const [aiExtractOpen, setAiExtractOpen] = useState(false);

  const [sharePasswordModalOpen, setSharePasswordModalOpen] = useState(false);
  const [sharePasswordValue, setSharePasswordValue] = useState("");
  const [sharePasswordSaving, setSharePasswordSaving] = useState(false);
  const [sharePasswordError, setSharePasswordError] = useState<string | null>(null);
  const [sharePasswordLoading, setSharePasswordLoading] = useState(false);
  const [sharePasswordVisible, setSharePasswordVisible] = useState(false);
/**
 * Save Share Password (updates state (setSharePasswordSaving, setSharePasswordError, setSharePasswordModalOpen); uses setSharePasswordSaving, setSharePasswordError, fetchJson).
 */


  async function saveSharePassword(nextPassword: string) {
    setSharePasswordSaving(true);
    setSharePasswordError(null);
    try {
      const res = await fetchJson<{ sharePasswordEnabled: boolean }>(
        `/api/docs/${docId}/share-password`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: nextPassword }),
        },
      );
      onSharePasswordEnabledChange(Boolean(res.sharePasswordEnabled));
      setSharePasswordModalOpen(false);
      setSharePasswordValue("");
    } catch (e) {
      setSharePasswordError(e instanceof Error ? e.message : "Failed to save password");
    } finally {
      setSharePasswordSaving(false);
    }
  }
/**
 * Remove Share Password (updates state (setSharePasswordSaving, setSharePasswordError, setSharePasswordModalOpen); uses setSharePasswordSaving, setSharePasswordError, fetchJson).
 */


  async function removeSharePassword() {
    setSharePasswordSaving(true);
    setSharePasswordError(null);
    try {
      const res = await fetchJson<{ sharePasswordEnabled: boolean }>(
        `/api/docs/${docId}/share-password`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ password: null }),
        },
      );
      onSharePasswordEnabledChange(Boolean(res.sharePasswordEnabled));
      setSharePasswordModalOpen(false);
      setSharePasswordValue("");
    } catch (e) {
      setSharePasswordError(e instanceof Error ? e.message : "Failed to remove password");
    } finally {
      setSharePasswordSaving(false);
    }
  }

  const displayValue = shareUrl || "Generating link…";

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

  const hasSnapshot = Boolean(oneLiner || why || scope.length || context || value || maturity || ask || metrics.length);
  const hasSummary = Boolean(summary);

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
        ? "Snapshot is not available for this upload yet."
        : "";

  return (
    <div className="min-h-0 overflow-auto rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-5">
      {/* 1) Share link */}
      <div>
        <div className="text-xs font-medium text-[var(--muted)]">Share link</div>

        <div className="mt-2 flex items-stretch gap-2">
          <input
            ref={shareInputRef}
            value={displayValue}
            readOnly
            className="h-9 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel-2)] px-3 text-[13px] font-medium text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              e.preventDefault();
              onCopy();
            }}
            aria-label="Share link"
          />
          <CopyButton
            copyDone={copyDone}
            isCopying={isCopying}
            disabled={!shareUrl}
            onCopy={onCopy}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-[var(--primary-bg)] text-[var(--primary-fg)] shadow-sm transition-colors duration-150 hover:bg-[var(--primary-hover-bg)] focus:outline-none focus:ring-2 focus:ring-[var(--primary-ring)] focus:ring-offset-2 focus:ring-offset-[var(--panel)] disabled:opacity-50"
            copyAriaLabel="Copy link"
            copiedAriaLabel="Copied"
          />
          <button
            type="button"
            onClick={() => {
              setSharePasswordError(null);
              setSharePasswordValue("");
              setSharePasswordVisible(false);
              setSharePasswordModalOpen(true);
              if (sharePasswordEnabled) {
                setSharePasswordLoading(true);
                void (async () => {
                  try {
                    const res = await fetchJson<{ sharePasswordEnabled: boolean; password: string | null }>(
                      `/api/docs/${docId}/share-password`,
                      { cache: "no-store" },
                    );
                    if (res.sharePasswordEnabled && typeof res.password === "string") {
                      setSharePasswordValue(res.password);
                    }
                  } catch {
                    // If we can't fetch/decrypt, fall back to empty input (still allows changing).
                  } finally {
                    setSharePasswordLoading(false);
                  }
                })();
              }
            }}
            disabled={!shareUrl || sharePasswordSaving}
            className="inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] text-[var(--muted)] shadow-sm transition-colors duration-150 hover:bg-[var(--panel-hover)] hover:text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)] focus:ring-offset-2 focus:ring-offset-[var(--panel)] disabled:opacity-50"
            aria-label={sharePasswordEnabled ? "Change share password" : "Set share password"}
            title={sharePasswordEnabled ? "Password protected" : "Not password protected"}
          >
            {sharePasswordEnabled ? (
              <LockClosedIcon className="h-4 w-4" aria-hidden="true" />
            ) : (
              <LockOpenIcon className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-[var(--fg)]">Allow download</div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={pdfDownloadEnabled}
            aria-label="Allow download"
            disabled={!shareUrl}
            className={[
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
              pdfDownloadEnabled ? "bg-[var(--primary-bg)]" : "bg-[var(--border)]",
              !shareUrl ? "opacity-50" : "cursor-pointer",
            ].join(" ")}
            onClick={() => onPdfDownloadEnabledChange(!pdfDownloadEnabled)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onPdfDownloadEnabledChange(!pdfDownloadEnabled);
            }}
          >
            <span
              aria-hidden="true"
              className={[
                "inline-block h-5 w-5 transform rounded-full bg-[var(--panel)] shadow ring-1 ring-[var(--border)] transition-transform",
                pdfDownloadEnabled ? "translate-x-5" : "translate-x-1",
              ].join(" ")}
            />
          </button>
        </div>

        <div className="mt-3 flex items-center justify-between gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2">
          <div className="min-w-0">
            <div className="text-[12px] font-medium text-[var(--fg)]">Enable revision history viewing</div>
            <div className="mt-0.5 text-[12px] text-[var(--muted)]">
              Show a light revision history to recipients (version + date + summary).
            </div>
          </div>

          <button
            type="button"
            role="switch"
            aria-checked={revisionHistoryEnabled}
            aria-label="Enable revision history viewing"
            disabled={!shareUrl}
            className={[
              "relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors",
              "focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--ring)]",
              revisionHistoryEnabled ? "bg-[var(--primary-bg)]" : "bg-[var(--border)]",
              !shareUrl ? "opacity-50" : "cursor-pointer",
            ].join(" ")}
            onClick={() => onRevisionHistoryEnabledChange(!revisionHistoryEnabled)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" && e.key !== " ") return;
              e.preventDefault();
              onRevisionHistoryEnabledChange(!revisionHistoryEnabled);
            }}
          >
            <span
              aria-hidden="true"
              className={[
                "inline-block h-5 w-5 transform rounded-full bg-[var(--panel)] shadow ring-1 ring-[var(--border)] transition-transform",
                revisionHistoryEnabled ? "translate-x-5" : "translate-x-1",
              ].join(" ")}
            />
          </button>
        </div>

        {/* a11y: announce copy state */}
        <div className="sr-only" aria-live="polite">
          {copyDone ? "Copied to clipboard" : ""}
        </div>
      </div>

      {/* 2) Snapshot */}
      {hasSnapshot ? (
        <div className="mt-6 border-t border-[var(--border)] pt-5">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
            <div className="flex items-center justify-between gap-3 pb-3">
              <div
                className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]"
                title="Snapshot (generated)"
              >
                <SparklesIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
                <span className="truncate">Snapshot</span>
                <span className="hidden rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)] sm:inline-flex">
                  Generated
                </span>
              </div>
              <div className="shrink-0">
                <button
                  type="button"
                  aria-label="Open full snapshot"
                  title="Open full snapshot"
                  className="inline-flex items-center gap-1 text-xs font-medium text-[var(--muted)] underline decoration-transparent underline-offset-4 transition-colors hover:text-[var(--fg)] hover:decoration-[var(--border)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
                  onClick={() => setAiExtractOpen(true)}
                >
                  Full snapshot
                </button>
              </div>
            </div>
            {oneLiner ? (
              <div className="mt-3 text-[13px] font-semibold leading-snug text-[var(--fg)]">
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
              <div className="mt-5 border-t border-[var(--border)] pt-4 text-[13px] leading-relaxed text-[var(--fg)]">
                <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                  Summary
                </div>
                <div className="mt-3">
                  <Markdown>{summary}</Markdown>
                </div>
              </div>
            ) : null}
          </div>
        </div>
      ) : (
        <div className="mt-6 border-t border-[var(--border)] pt-5">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-5 py-4">
            <div
              className="inline-flex min-w-0 items-center gap-2 text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]"
              title="Snapshot (generated)"
            >
              <SparklesIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
              <span className="truncate">Snapshot</span>
              <span className="hidden rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)] sm:inline-flex">
                Generated
              </span>
            </div>
            <div className="mt-2 text-[13px] leading-relaxed text-[var(--muted)]">
              {aiMissingMessage}
            </div>
          </div>
        </div>
      )}

      <Modal
        open={aiExtractOpen}
        onClose={() => setAiExtractOpen(false)}
        ariaLabel="Snapshot (generated)"
        panelClassName="w-[min(860px,calc(100vw-32px))]"
      >
        <div className="flex items-center gap-2 text-base font-semibold text-[var(--fg)]">
          <span>Snapshot</span>
          <span className="hidden rounded-md border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--muted)] sm:inline-flex">
            Generated
          </span>
        </div>
        <div className="mt-2 text-sm text-[var(--muted)]">
          Structured context captured from the document.
        </div>

        {oneLiner ? (
          <div className="mt-5 text-lg font-semibold text-[var(--fg)]">{oneLiner}</div>
        ) : null}

        <div className="mt-5 grid gap-4">
          {why ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--muted)]">
                Why this exists
              </div>
              <div className="mt-1 text-sm leading-relaxed text-[var(--fg)]">{why}</div>
            </div>
          ) : null}

          {context ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--muted)]">
                Context
              </div>
              <div className="mt-1 text-sm leading-relaxed text-[var(--fg)]">{context}</div>
            </div>
          ) : null}

          {value ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--muted)]">
                Value
              </div>
              <div className="mt-1 text-sm leading-relaxed text-[var(--fg)]">{value}</div>
            </div>
          ) : null}

          {maturity ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--muted)]">
                Status
              </div>
              <div className="mt-1 text-sm leading-relaxed text-[var(--fg)]">{maturity}</div>
            </div>
          ) : null}

          {ask ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--muted)]">
                Ask
              </div>
              <div className="mt-1 text-sm leading-relaxed text-[var(--fg)]">{ask}</div>
            </div>
          ) : null}

          {scope.length ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--muted)]">
                What it covers
              </div>
              <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-[var(--fg)]">
                {scope.slice(0, 12).map((s) => (
                  <li key={`scope_full:${s}`}>{s}</li>
                ))}
              </ul>
            </div>
          ) : null}

          {metrics.length ? (
            <div className="rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
              <div className="text-[11px] font-bold uppercase tracking-widest text-[var(--muted)]">
                Key metrics
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                {metrics.slice(0, 12).map((m) => (
                  <span
                    key={`metric:${m}`}
                    className="rounded-full bg-[var(--panel)] px-3 py-1 text-xs font-medium text-[var(--muted)] ring-1 ring-[var(--border)]"
                  >
                    {m}
                  </span>
                ))}
              </div>
            </div>
          ) : null}
        </div>
      </Modal>

      <Modal
        open={sharePasswordModalOpen}
        onClose={() => {
          if (sharePasswordSaving) return;
          setSharePasswordModalOpen(false);
          setSharePasswordError(null);
          setSharePasswordValue("");
          setSharePasswordVisible(false);
        }}
        ariaLabel="Password protect share link"
      >
        <div className="text-base font-semibold text-[var(--fg)]">Password protect share link</div>
        <div className="mt-2 text-sm text-[var(--muted)]">
          Anyone with the link will need this password to view the document.
        </div>

        <div className="mt-5">
          <label className="text-xs font-medium text-[var(--muted)]" htmlFor="share-password-owner">
            {sharePasswordEnabled ? "Password" : "New password"}
          </label>
          <div className="mt-2 flex items-stretch gap-2">
            <input
              id="share-password-owner"
              type={sharePasswordVisible ? "text" : "password"}
              value={sharePasswordValue}
              onChange={(e) => setSharePasswordValue(e.currentTarget.value)}
              onKeyDown={(e) => {
                if (e.key !== "Enter") return;
                e.preventDefault();
                const v = sharePasswordValue.trim();
                if (!v || sharePasswordSaving) return;
                void saveSharePassword(v);
              }}
              className="h-10 min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-sm text-[var(--fg)] focus:outline-none focus:ring-2 focus:ring-[var(--ring)]"
              placeholder={sharePasswordLoading ? "Loading…" : "Enter a password"}
              autoComplete={sharePasswordEnabled ? "current-password" : "new-password"}
              autoFocus
              disabled={sharePasswordLoading}
            />
            <button
              type="button"
              onClick={() => setSharePasswordVisible((v) => !v)}
              className="inline-flex h-10 shrink-0 items-center justify-center rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
              aria-label={sharePasswordVisible ? "Hide password" : "Show password"}
              title={sharePasswordVisible ? "Hide" : "Show"}
            >
              {sharePasswordVisible ? "Hide" : "Show"}
            </button>
          </div>
        </div>

        {sharePasswordError ? (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-800">
            {sharePasswordError}
          </div>
        ) : null}

        <div className="mt-6 flex flex-wrap items-center justify-between gap-3">
          {sharePasswordEnabled ? (
            <button
              type="button"
              onClick={() => void removeSharePassword()}
              disabled={sharePasswordSaving}
              className="rounded-lg border border-red-200 bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-red-700 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Remove password
            </button>
          ) : (
            <div className="text-xs text-[var(--muted-2)]">No password is currently set.</div>
          )}

          <button
            type="button"
            onClick={() => {
              const v = sharePasswordValue.trim();
              if (!v) {
                setSharePasswordError("Please enter a password.");
                return;
              }
              void saveSharePassword(v);
            }}
            disabled={sharePasswordSaving}
            className="inline-flex items-center justify-center rounded-lg bg-[var(--primary-bg)] px-4 py-2 text-sm font-semibold text-[var(--primary-fg)] hover:bg-[var(--primary-hover-bg)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            {sharePasswordSaving ? "Saving…" : sharePasswordEnabled ? "Change password" : "Set password"}
          </button>
        </div>
      </Modal>
    </div>
  );
}
