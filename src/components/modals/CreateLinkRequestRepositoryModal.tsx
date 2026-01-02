"use client";

import { ChevronDownIcon, SparklesIcon, Square2StackIcon } from "@heroicons/react/24/outline";
import Modal from "@/components/modals/Modal";
import { CopyButton } from "@/components/CopyButton";
import { useCallback, useEffect, useRef, useState } from "react";

/**
 * Render the CreateLinkRequestRepositoryModal UI.
 */
export default function CreateLinkRequestRepositoryModal({
  open,
  onModalClose,
  onClickClose,
  onClickCancel,
  onOpenCreatedProject,
  onOpenReviewPerspective,
  onCreate,
  requestBusy,
  requestBusyStep,
  requestName,
  setRequestName,
  requestDescription,
  setRequestDescription,
  requestRequireAuthToUpload,
  setRequestRequireAuthToUpload,
  requestReviewEnabled,
  setRequestReviewEnabled,
  requestReviewAgentLabel,
  setRequestReviewAgentLabel,
  requestReviewGuideFile,
  setRequestReviewGuideFile,
  requestReviewGuideText,
  setRequestReviewGuideText,
  requestTriedSubmit,
  requestError,
  setRequestError,
  createdRequestUploadUrl,
  createdRequestViewUrl,
  createdRequestProjectId,
}: {
  open: boolean;
  onModalClose: () => void;
  onClickClose: () => void;
  onClickCancel: () => void;
  onOpenCreatedProject: () => void;
  onOpenReviewPerspective: () => void;
  onCreate: () => void | Promise<void>;
  requestBusy: boolean;
  requestBusyStep: "idle" | "creating" | "uploading_guide" | "processing_guide" | "finalizing";
  requestName: string;
  setRequestName: (v: string) => void;
  requestDescription: string;
  setRequestDescription: (v: string) => void;
  requestRequireAuthToUpload: boolean;
  setRequestRequireAuthToUpload: (v: boolean) => void;
  requestReviewEnabled: boolean;
  setRequestReviewEnabled: (v: boolean) => void;
  requestReviewAgentLabel: string | null;
  setRequestReviewAgentLabel: (v: string | null) => void;
  requestReviewGuideFile: File | null;
  setRequestReviewGuideFile: (v: File | null) => void;
  requestReviewGuideText: string;
  setRequestReviewGuideText: (v: string) => void;
  requestTriedSubmit: boolean;
  requestError: string | null;
  setRequestError: (v: string | null) => void;
  createdRequestUploadUrl: string | null;
  createdRequestViewUrl: string | null;
  createdRequestProjectId: string | null;
}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [showScrollCue, setShowScrollCue] = useState(false);
  const [uploadLinkCopying, setUploadLinkCopying] = useState(false);
  const [uploadLinkCopied, setUploadLinkCopied] = useState(false);
  const [viewLinkCopying, setViewLinkCopying] = useState(false);
  const [viewLinkCopied, setViewLinkCopied] = useState(false);

  const syncScrollCue = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const hasOverflow = el.scrollHeight > el.clientHeight + 2;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - 12;
    setShowScrollCue(hasOverflow && !atBottom);
  }, []);

  useEffect(() => {
    if (!open) return;
    syncScrollCue();
  }, [open, syncScrollCue]);

  useEffect(() => {
    if (!open) return;
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => syncScrollCue();
    el.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", syncScrollCue);
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", syncScrollCue);
    };
  }, [open, syncScrollCue]);

  useEffect(() => {
    if (!open) return;
    // When toggling Automatic review, content height changes—recompute.
    syncScrollCue();
  }, [open, requestReviewEnabled, requestBusy, requestBusyStep, syncScrollCue]);

  const onClickScrollDown = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ top: Math.max(160, Math.floor(el.clientHeight * 0.75)), behavior: "smooth" });
  }, []);

  const copyUploadLink = useCallback(async () => {
    if (!createdRequestUploadUrl) return;
    setUploadLinkCopying(true);
    setUploadLinkCopied(false);
    try {
      await navigator.clipboard.writeText(createdRequestUploadUrl);
      setUploadLinkCopied(true);
      window.setTimeout(() => setUploadLinkCopied(false), 1000);
    } catch {
      // ignore
    } finally {
      setUploadLinkCopying(false);
    }
  }, [createdRequestUploadUrl]);

  const copyViewLink = useCallback(async () => {
    if (!createdRequestViewUrl) return;
    setViewLinkCopying(true);
    setViewLinkCopied(false);
    try {
      await navigator.clipboard.writeText(createdRequestViewUrl);
      setViewLinkCopied(true);
      window.setTimeout(() => setViewLinkCopied(false), 1000);
    } catch {
      // ignore
    } finally {
      setViewLinkCopying(false);
    }
  }, [createdRequestViewUrl]);

  return (
    <Modal
      open={open}
      onClose={onModalClose}
      ariaLabel="Create link request repository"
      panelClassName="w-[min(720px,calc(100vw-32px))]"
      contentClassName="flex flex-col overflow-hidden"
    >
      <div className="flex min-h-0 flex-1 flex-col">
        <div className="shrink-0">
          <div className="text-base font-semibold text-[var(--fg)]">Create link request repository</div>
          <div className="mt-1 text-sm text-[var(--muted)]">
            Create a request link for anyone to upload documents. All submissions land in this repository.
          </div>
        </div>

        {createdRequestUploadUrl ? (
          <>
            <div className="mt-5 min-h-0 flex-1 overflow-y-auto pr-1">
              <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Upload link</div>
              <div className="mt-1 text-sm text-[var(--muted)]">
                Share this link with the people you’re requesting documents from.
              </div>
              <div className="mt-2 flex items-center gap-2">
                <input
                  readOnly
                  value={createdRequestUploadUrl}
                  className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)]"
                />
                <CopyButton
                  copyDone={uploadLinkCopied}
                  isCopying={uploadLinkCopying}
                  disabled={!createdRequestUploadUrl}
                  onCopy={() => void copyUploadLink()}
                  className="inline-flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold hover:bg-[var(--panel-hover)] disabled:opacity-50"
                  iconClassName="h-4 w-4"
                  label="Copy"
                  copiedLabel="Copied"
                  copyAriaLabel="Copy"
                  copiedAriaLabel="Copied"
                  copyTitle="Copy"
                  copiedTitle="Copied"
                />
              </div>

              {createdRequestViewUrl ? (
                <div className="mt-5">
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                    Viewing link (read-only)
                  </div>
                  <div className="mt-1 text-sm text-[var(--muted)]">
                    Share this link to let someone view documents in this repository without enabling uploads.
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      readOnly
                      value={createdRequestViewUrl}
                      className="w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)]"
                    />
                    <CopyButton
                      copyDone={viewLinkCopied}
                      isCopying={viewLinkCopying}
                      disabled={!createdRequestViewUrl}
                      onCopy={() => void copyViewLink()}
                      className="inline-flex items-center gap-1 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] font-semibold hover:bg-[var(--panel-hover)] disabled:opacity-50"
                      iconClassName="h-4 w-4"
                      label="Copy"
                      copiedLabel="Copied"
                      copyAriaLabel="Copy"
                      copiedAriaLabel="Copied"
                      copyTitle="Copy"
                      copiedTitle="Copied"
                    />
                  </div>
                </div>
              ) : null}
            </div>

            <div className="mt-4 shrink-0 border-t border-[var(--border)] bg-[var(--panel)] pt-3">
              {requestError ? (
                <div className="mb-3 text-sm text-red-600" role="alert" aria-live="polite">
                  {requestError}
                </div>
              ) : null}
              <div className="flex items-center justify-between gap-3">
                <button
                  type="button"
                  className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold hover:bg-[var(--panel-hover)]"
                  onClick={onClickClose}
                >
                  Close
                </button>
                {createdRequestProjectId ? (
                  <button
                    type="button"
                    className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-black/90"
                    onClick={onOpenCreatedProject}
                  >
                    Open Link Request Repo
                  </button>
                ) : null}
              </div>
            </div>
          </>
        ) : (
          <>
            <div className="mt-5 min-h-0 flex-1">
              <div ref={scrollRef} className="h-full space-y-3 overflow-y-auto pr-1">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Name</div>
                  <input
                    value={requestName}
                    onChange={(e) => setRequestName(e.target.value)}
                    placeholder="e.g., Pitch decks, project proposals, resumes"
                    className="mt-2 w-full rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10"
                  />
                </div>

                <div>
                  <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                    Instructions (optional)
                  </div>
                  <textarea
                    value={requestDescription}
                    onChange={(e) => setRequestDescription(e.target.value)}
                    placeholder="Add instructions for the uploader (what to include, format, deadline, etc.)"
                    rows={3}
                    className="mt-2 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10"
                  />
                </div>

                <div className="mt-1 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
                  <label className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-[var(--fg)]">Require sign-in to upload</div>
                      <div className="mt-0.5 text-xs text-[var(--muted)]">
                        Only authenticated (signed-in) users can submit documents to this request link.
                      </div>
                    </div>

                    <button
                      type="button"
                      role="switch"
                      aria-checked={requestRequireAuthToUpload}
                      aria-label="Require sign-in to upload"
                      className={[
                        "relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full transition-colors",
                        "focus:outline-none focus-visible:ring-2 focus-visible:ring-black/10 dark:focus-visible:ring-white/10",
                        requestRequireAuthToUpload ? "bg-black dark:bg-white" : "bg-[var(--border)]",
                        requestBusy ? "opacity-60" : "",
                      ].join(" ")}
                      disabled={requestBusy}
                      onClick={() => setRequestRequireAuthToUpload(!requestRequireAuthToUpload)}
                      onKeyDown={(e) => {
                        if (e.key !== "Enter" && e.key !== " ") return;
                        e.preventDefault();
                        setRequestRequireAuthToUpload(!requestRequireAuthToUpload);
                      }}
                    >
                      <span
                        aria-hidden="true"
                        className={[
                          "inline-block h-5 w-5 transform rounded-full bg-[var(--panel)] shadow ring-1 ring-[var(--border)] transition-transform",
                          requestRequireAuthToUpload ? "translate-x-5" : "translate-x-1",
                        ].join(" ")}
                      />
                    </button>
                  </label>
                </div>

                <div className="mt-1 rounded-2xl border border-[var(--border)] bg-[var(--panel)] p-4">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2 text-sm font-semibold text-[var(--fg)]">
                        <SparklesIcon className="h-4 w-4 text-[var(--muted)]" aria-hidden="true" />
                        <span>Submission review</span>
                      </div>
                    </div>
                  </div>

                  <fieldset className="mt-3" aria-label="Submission review">
                    <legend className="sr-only">Submission review</legend>
                    <div role="radiogroup" className="grid gap-2 sm:grid-cols-2">
                      <label
                        className={[
                          "flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2",
                          !requestReviewEnabled
                            ? "border-[var(--ring)] bg-[var(--panel-2)]"
                            : "border-[var(--border)] bg-[var(--panel)]",
                        ].join(" ")}
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-semibold text-[var(--fg)]">Uploads only</div>
                          <div className="mt-0.5 text-xs text-[var(--muted)]">
                            Collect submissions without automatic analysis.
                          </div>
                        </div>
                        <input
                          type="radio"
                          name="submission-review"
                          value="uploads"
                          checked={!requestReviewEnabled}
                          onChange={() => {
                            setRequestReviewEnabled(false);
                            setRequestReviewAgentLabel(null);
                            setRequestReviewGuideFile(null);
                            setRequestReviewGuideText("");
                            setRequestError(null);
                          }}
                          className="h-4 w-4 accent-black"
                        />
                      </label>

                      <label
                        className={[
                          "flex cursor-pointer items-center justify-between gap-3 rounded-xl border px-3 py-2",
                          requestReviewEnabled
                            ? "border-[var(--ring)] bg-[var(--panel-2)]"
                            : "border-[var(--border)] bg-[var(--panel)]",
                        ].join(" ")}
                      >
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <div className="text-sm font-semibold text-[var(--fg)]">Automatic review</div>
                            <span className="rounded-full border border-[var(--border)] bg-[var(--panel)] px-2 py-0.5 text-[10px] font-semibold text-[var(--muted)]">
                              Recommended
                            </span>
                          </div>
                          <div className="mt-0.5 text-xs text-[var(--muted)]">
                            Analyze each submission and generate a summary and score.
                          </div>
                        </div>
                        <input
                          type="radio"
                          name="submission-review"
                          value="review"
                          checked={requestReviewEnabled}
                          onChange={() => {
                            setRequestReviewEnabled(true);
                            if (!requestReviewAgentLabel) setRequestReviewAgentLabel("Venture Capitalist");
                          }}
                          className="h-4 w-4 accent-black"
                        />
                      </label>
                    </div>
                  </fieldset>

                  {requestReviewEnabled ? (
                    <div className="mt-3">
                      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                        Review perspective
                      </div>
                      <div className="mt-2 flex items-center justify-between gap-3">
                        <div className="text-sm text-[var(--muted)]">Choose the lens used to evaluate each submission.</div>
                        <button
                          type="button"
                          className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                          onClick={onOpenReviewPerspective}
                        >
                          View perspectives
                        </button>
                      </div>
                      <div className="mt-1 text-sm text-[var(--muted)]">
                        Currently supports Venture Capitalist. More perspectives are coming soon.
                      </div>
                      {requestReviewAgentLabel ? (
                        <div className="mt-2 text-sm text-[var(--muted)]">
                          Selected: <span className="font-semibold text-[var(--fg)]">{requestReviewAgentLabel}</span>
                        </div>
                      ) : null}

                      <div className="mt-4">
                        <div
                          id="evaluation-guide-label"
                          className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]"
                        >
                          Evaluation guide (PDF) *
                        </div>
                        <div id="evaluation-guide-help" className="mt-1 text-sm text-[var(--muted)]">
                          This defines how an automated AI system evaluates, scores, and summarizes each submission. (PDF only, max 1MB)
                        </div>
                        {requestBusy ? (
                          <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-4 py-3">
                            <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">Status</div>
                            <div className="mt-2 text-sm text-[var(--fg)]">
                              {requestBusyStep === "creating"
                                ? "Creating repository…"
                                : requestBusyStep === "uploading_guide"
                                  ? "Uploading evaluation guide…"
                                  : requestBusyStep === "processing_guide"
                                    ? "Processing evaluation guide…"
                                    : requestBusyStep === "finalizing"
                                      ? "Finalizing…"
                                      : "Working…"}
                            </div>
                            <div className="mt-1 text-sm text-[var(--muted)]">Please keep this modal open.</div>
                            <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-[var(--border)]">
                              <div className="h-full w-1/3 animate-pulse rounded-full bg-black dark:bg-white" />
                            </div>
                            <div className="sr-only" aria-live="polite">
                              {requestBusyStep === "creating"
                                ? "Creating repository"
                                : requestBusyStep === "uploading_guide"
                                  ? "Uploading evaluation guide"
                                  : requestBusyStep === "processing_guide"
                                    ? "Processing evaluation guide"
                                    : requestBusyStep === "finalizing"
                                      ? "Finalizing"
                                      : ""}
                            </div>
                          </div>
                        ) : null}
                        <div className="mt-2 flex items-center justify-between gap-3">
                          <input
                            type="file"
                            accept="application/pdf"
                            aria-labelledby="evaluation-guide-label"
                            aria-describedby="evaluation-guide-help"
                            disabled={requestBusy}
                            className={[
                              "cursor-pointer text-[13px] text-[var(--muted)]",
                              "focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10",
                              "disabled:cursor-not-allowed disabled:opacity-60",
                              // Style the native file-selector button to match secondary buttons elsewhere in the modal.
                              "file:mr-3 file:rounded-lg file:border file:border-[var(--border)] file:bg-[var(--panel)]",
                              "file:px-2.5 file:py-1.5 file:text-[12px] file:font-semibold file:text-[var(--fg)]",
                              "hover:file:bg-[var(--panel-hover)]",
                            ].join(" ")}
                            onChange={(e) => {
                              const f = e.currentTarget.files?.[0] ?? null;
                              setRequestReviewGuideFile(f);
                            }}
                          />
                          {requestReviewGuideFile ? (
                            <button
                              type="button"
                              className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-2.5 py-1.5 text-[12px] font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)]"
                              onClick={() => setRequestReviewGuideFile(null)}
                            >
                              Clear
                            </button>
                          ) : null}
                        </div>
                        {requestReviewGuideFile ? (
                          <div className="mt-1 text-sm text-[var(--muted)]">Selected: {requestReviewGuideFile.name}</div>
                        ) : null}
                        <div className="mt-3">
                          <div className="text-xs font-semibold uppercase tracking-wide text-[var(--muted-2)]">
                            Or paste guide text
                          </div>
                          <textarea
                            value={requestReviewGuideText}
                            onChange={(e) => setRequestReviewGuideText(e.target.value)}
                            disabled={requestBusy}
                            rows={4}
                            className="mt-2 w-full resize-none rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[13px] text-[var(--fg)] placeholder:text-[var(--muted-2)] focus:outline-none focus:ring-2 focus:ring-black/10 dark:focus:ring-white/10 disabled:opacity-60"
                            placeholder="Paste evaluation criteria or scoring rubric text…"
                            aria-label="Paste evaluation guide text"
                          />
                        </div>

                        {requestTriedSubmit &&
                        requestReviewEnabled &&
                        !requestReviewGuideFile &&
                        !requestReviewGuideText.trim() ? (
                          <div className="mt-2 text-sm text-red-600" role="alert" aria-live="polite">
                            Evaluation guide is required for automatic review.
                          </div>
                        ) : null}
                      </div>
                    </div>
                  ) : null}
                </div>
              </div>
            </div>

            <div className="mt-4 shrink-0 border-t border-[var(--border)] bg-[var(--panel)] pt-3">
              {requestError ? (
                <div className="mb-3 text-sm text-red-600" role="alert" aria-live="polite">
                  {requestError}
                </div>
              ) : null}

              <div className="flex items-center gap-3">
                <button
                  type="button"
                  disabled={requestBusy}
                  className="rounded-xl border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold hover:bg-[var(--panel-hover)] disabled:cursor-not-allowed disabled:opacity-60"
                  onClick={onClickCancel}
                >
                  Cancel
                </button>
                <div className="flex flex-1 justify-center">
                  {showScrollCue ? (
                    <button
                      type="button"
                      className="inline-flex items-center justify-center rounded-full border border-[var(--border)] bg-[var(--panel)] p-2 text-[var(--muted)] shadow-sm hover:bg-[var(--panel-hover)] hover:text-[var(--fg)]"
                      aria-label="Scroll down"
                      onClick={onClickScrollDown}
                    >
                      <ChevronDownIcon className="h-5 w-5" aria-hidden="true" />
                    </button>
                  ) : null}
                </div>
                <button
                  type="button"
                  disabled={
                    requestBusy ||
                    !requestName.trim() ||
                    (requestReviewEnabled && !requestReviewGuideFile && !requestReviewGuideText.trim())
                  }
                  className="rounded-xl bg-black px-4 py-2 text-sm font-semibold text-white hover:bg-black/90 disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void onCreate()}
                >
                  {requestBusy ? "Creating…" : "Create repository"}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}


