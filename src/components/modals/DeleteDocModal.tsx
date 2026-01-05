"use client";

import Modal from "@/components/modals/Modal";

type DocFolder = { id: string; name: string; slug: string };

/**
 * Render the DeleteDocModal UI.
 */
export default function DeleteDocModal({
  open,
  busy,
  canConfirm,
  docTitle,
  foldersBusy,
  folders,
  error,
  onClose,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  busy: boolean;
  canConfirm: boolean;
  docTitle: string;
  foldersBusy: boolean;
  folders: DocFolder[] | null;
  error: string | null;
  onClose: () => void;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const title = (docTitle ?? "").trim();
  const displayTitle = title ? `“${title}”` : "this document";
  return (
    <Modal
      open={open}
      ariaLabel="Delete document"
      onClose={() => {
        if (busy) return;
        onClose();
      }}
      panelClassName="w-[min(560px,calc(100vw-32px))]"
    >
      <div className="text-base font-semibold text-[var(--fg)]">Delete document?</div>
      <div className="mt-2 text-sm text-[var(--muted)]">
        This will permanently delete <span className="font-semibold text-[var(--fg)]">{displayTitle}</span>. This can’t be
        undone.
      </div>

      <div className="mt-3 rounded-xl border border-[var(--border)] bg-[var(--panel-2)] px-3 py-2 text-sm text-[var(--fg)]">
        <div className="font-semibold text-[var(--fg)]">Also removed from</div>
        {foldersBusy ? (
          <div className="mt-1 text-[var(--muted)]">Loading…</div>
        ) : folders && folders.length ? (
          <ul className="mt-1 space-y-0.5">
            {folders.map((f) => (
              <li key={f.id} className="flex items-center justify-between gap-2">
                <span className="truncate">
                  {f.name || "Untitled folder"}
                  {f.slug ? <span className="ml-2 text-xs text-[var(--muted-2)]">({f.slug})</span> : null}
                </span>
              </li>
            ))}
          </ul>
        ) : folders ? (
          <div className="mt-1 text-[var(--muted)]">Not in any folders</div>
        ) : (
          <div className="mt-1 text-[var(--muted)]">Folders will appear here.</div>
        )}
        <div className="mt-2 text-xs text-[var(--muted-2)]">
          Deleting a document removes it from your documents list and any folders it’s in.
        </div>
      </div>

      {error ? <div className="mt-3 text-sm font-medium text-red-600">{error}</div> : null}

      <div className="mt-5 flex items-center justify-end gap-3">
        <button
          type="button"
          className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-4 py-2 text-sm font-semibold text-[var(--fg)] hover:bg-[var(--panel-hover)] disabled:opacity-50"
          disabled={Boolean(busy)}
          onClick={onCancel}
        >
          Cancel
        </button>
        <button
          type="button"
          className="inline-flex items-center justify-center rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"
          disabled={Boolean(busy) || !canConfirm}
          onClick={onConfirm}
        >
          {busy ? "Deleting…" : "Delete"}
        </button>
      </div>
    </Modal>
  );
}


