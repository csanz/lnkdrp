"use client";

import { useEffect, useState } from "react";
import Modal from "@/components/modals/Modal";

export type RequestRepoDeleteMode = "orphan" | "copy_to_new_project" | "delete_docs";

/**
 * Render the DeleteRequestRepoModal UI.
 */
export default function DeleteRequestRepoModal({
  open,
  repoName,
  onClose,
  onConfirm,
  busy,
  error,
}: {
  open: boolean;
  repoName: string;
  onClose: () => void;
  onConfirm: (mode: RequestRepoDeleteMode) => void;
  busy?: boolean;
  error?: string | null;
}) {
  const [mode, setMode] = useState<RequestRepoDeleteMode>("orphan");

  useEffect(() => {
    if (!open) return;
    setMode("orphan");
  }, [open]);

  return (
    <Modal
      open={open}
      ariaLabel="Delete request repository"
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      panelClassName="w-[min(640px,calc(100vw-32px))]"
    >
      <div className="text-base font-semibold text-[var(--fg)]">Delete request repository?</div>
      <div className="mt-2 text-sm text-[var(--muted)]">
        You’re deleting <span className="font-semibold text-[var(--fg)]">{repoName}</span>. Choose what should happen to
        its docs.
      </div>

      <div className="mt-4 grid gap-2">
        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-3 hover:bg-[var(--panel-hover)]">
          <input
            type="radio"
            name="delete-request-mode"
            className="mt-1"
            checked={mode === "orphan"}
            onChange={() => setMode("orphan")}
            disabled={Boolean(busy)}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">Leave docs unfiled</div>
            <div className="mt-0.5 text-sm text-[var(--muted)]">
              Docs will remain in your Docs list, but won’t belong to any project.
            </div>
          </div>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-[var(--border)] bg-[var(--panel)] px-3 py-3 hover:bg-[var(--panel-hover)]">
          <input
            type="radio"
            name="delete-request-mode"
            className="mt-1"
            checked={mode === "copy_to_new_project"}
            onChange={() => setMode("copy_to_new_project")}
            disabled={Boolean(busy)}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-[var(--fg)]">Copy docs to a new project</div>
            <div className="mt-0.5 text-sm text-[var(--muted)]">
              A new non-request project will be created, and these docs will be added to it.
            </div>
          </div>
        </label>

        <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-red-200 bg-red-50/60 px-3 py-3 hover:bg-red-50">
          <input
            type="radio"
            name="delete-request-mode"
            className="mt-1"
            checked={mode === "delete_docs"}
            onChange={() => setMode("delete_docs")}
            disabled={Boolean(busy)}
          />
          <div className="min-w-0">
            <div className="text-sm font-semibold text-red-800">Delete all docs</div>
            <div className="mt-0.5 text-sm text-red-700">Docs will be deleted. You can’t undo this.</div>
          </div>
        </label>
      </div>

      {error ? <div className="mt-3 text-sm font-medium text-red-600">{error}</div> : null}

      <div className="mt-5 flex items-center justify-end gap-3">
        <button
          type="button"
          className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
          disabled={Boolean(busy)}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          disabled={Boolean(busy)}
          onClick={() => onConfirm(mode)}
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}


