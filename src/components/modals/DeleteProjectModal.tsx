"use client";

import Modal from "@/components/modals/Modal";

export default function DeleteProjectModal({
  open,
  projectName,
  onClose,
  onConfirm,
  busy,
  error,
}: {
  open: boolean;
  projectName: string;
  onClose: () => void;
  onConfirm: () => void;
  busy?: boolean;
  error?: string | null;
}) {
  return (
    <Modal
      open={open}
      ariaLabel="Delete project"
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      panelClassName="w-[min(560px,calc(100vw-32px))]"
    >
      <div className="text-base font-semibold text-zinc-900">Delete project?</div>
      <div className="mt-2 text-sm text-zinc-700">
        This will remove <span className="font-semibold text-zinc-900">{projectName}</span> and
        unlink it from any docs. You can’t undo this.
      </div>

      {error ? <div className="mt-3 text-sm font-medium text-red-700">{error}</div> : null}

      <div className="mt-5 flex items-center justify-end gap-3">
        <button
          type="button"
          className="rounded-lg border border-zinc-200 bg-white px-4 py-2 text-sm font-semibold text-zinc-800 hover:bg-zinc-50 disabled:opacity-50"
          disabled={Boolean(busy)}
          onClick={onClose}
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          disabled={Boolean(busy)}
          onClick={onConfirm}
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}


